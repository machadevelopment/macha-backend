import * as XLSX from 'xlsx';
import { and, eq, isNotNull, isNull, sql as rawSql } from 'drizzle-orm';
import { registerWorker, enqueue, QUEUES } from '@/queue';
import { withCompanyScope } from '@/lib/db-scope';
import {
  DiccionarioDeCategorias,
  guardarReglasAprendidas,
  resolverLoteConDiccionario,
  type ReglaAprendida,
} from '@/lib/category-dictionary';
import { downloadObject } from '@/lib/s3';
import {
  documents,
  documentIngestBatches,
  companies,
  ingestedRows,
  stagingRows,
  transactions,
  invoices,
  bills,
} from '@/db/schema';
import { intakeConfig } from '@/config/intake';
import { INTAKE_MESSAGES, summarizeUnusableReasons } from '@/lib/intake-messages';
import {
  classifySheetRows,
  construirFilas,
  fusionarMapaDeColumnas,
  type VeredictoCrudo,
} from '@/lib/anthropic';
import { asDate, asNumber, detectarOrdenDeFecha, type ColumnMap } from '@/lib/row-assembly';
import { resolveIndustryTemplate } from '@/lib/industry-template';
import { planBatchSize } from '@/lib/sheet-batching';
import {
  CanonizadorDeCategorias,
  ConfianzaPorHoja,
  ConsensoDeHoja,
  elegirSonda,
  filaAptaParaCortocircuito,
  type VeredictoDominante,
} from '@/lib/sheet-consensus';
import { fingerprintSheet, findSeenFingerprints } from '@/lib/row-fingerprint';
import { medirFilas } from '@/lib/reconciliation';
import { mapaDeDineroProbable } from '@/lib/sheet-money';
import { avisarConceptosPendientes } from '@/lib/aviso-de-revision';
import {
  evaluarCuadre,
  evaluarCuadrePorHoja,
  hayDescuadre,
  hojasDescuadradas,
  type AterrizadoEnElLedger,
  type LeidoDelArchivo,
} from '@/lib/cuadre';
import { detectarFilaDeEncabezado } from '@/lib/sheet-header';
import { analizarFormaDeHoja } from '@/lib/sheet-shape';
import { detectarDetalleDuplicado } from '@/lib/sheet-duplication';
import { claveDeConceptoAncho, despivotarReporte, inferirAnio } from '@/lib/sheet-unpivot';
import {
  canSkipSheet,
  firmaDeCatalogo,
  noPuedeProducirMovimientos,
  pareceLibroDeMovimientos,
} from '@/lib/sheet-classifier';
import {
  importarInventario,
  mapearInventarioSerializado,
  type MapaDeInventario,
} from '@/lib/inventory-import';
import { analizarEsquema, type EsquemaDelLibro } from '@/lib/sheet-relations';
import { columnasEnPalabras, construirResumen, type HojaLeida } from '@/lib/read-summary';
import type { Currency } from '@/lib/fx';
import {
  ameritaAdvertencia,
  diferenciasDeMapa,
  guardarPerfil,
  perfilVigente,
  type PerfilDeColumnas,
} from '@/lib/column-profile';
import { insertStagingRows } from '@/lib/staging';
import { runWithConcurrency } from '@/lib/concurrency';
import { insertAiUsageEvent } from '@/lib/ai-usage';
import { promoteDocument } from '@/lib/promotion';
import { refreshExistingRollups } from '@/lib/rollups';
import {
  getActiveCreditRule,
  estimateRequiredCredits,
  debitCredits,
  cargaYaDebitada,
} from '@/lib/credits';

type ExcelIngestPayload = { documentId: string; companyId: string };

function chunk<T>(items: T[], size: number): T[][] {
  if (size <= 0 || items.length <= size) return [items];
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * CU-868kfva8v: worker de estandarización, mayor riesgo del MVP. Cada paso que toca
 * DB usa su propia transacción corta (withCompanyScope) — NO se envuelve todo el
 * worker en una sola transacción, porque el trabajo entre pasos incluye llamadas de
 * red lentas (descarga S3, Claude) que no deben mantener una conexión reservada del
 * pool abierta durante minutos bajo carga concurrente.
 *
 * CU-868kkgypv — ES REANUDABLE, NO SOLO IDEMPOTENTE. La contrapartida de esas
 * transacciones cortas es que un fallo a media ejecución deja confirmados los lotes ya
 * hechos, y pg-boss reintenta el job entero (retryLimit 3). Antes eso reprocesaba desde
 * la primera hoja: `staging_rows` duplicadas —y por tanto transacciones/facturas dobles
 * al promover—, créditos cobrados de nuevo sobre un ledger append-only y `cost_usd`
 * inflado.
 *
 * LA UNIDAD DE PROGRESO ES EL LOTE (hoja + índice), registrada en
 * `document_ingest_batches`. Se eligió el lote y no la fila porque Claude puede devolver
 * más o menos filas que las de entrada y no hay clave estable posición-a-posición; y no
 * el documento porque reintentar así vuelve a gastar todas las llamadas ya pagadas. El
 * lote es exactamente lo que consume una llamada a Claude, que es lo que no se quiere
 * repetir. La marca se inserta en la MISMA transacción que los tres efectos del lote, así
 * que o se confirma todo o no queda nada.
 *
 * Sin Excels de muestra reales de Macha (CU-868kfv9cb, en backlog) todavía — el
 * prompt/mapeo (ver lib/anthropic.ts) es un primer pase razonable sobre la taxonomía
 * fija del PRD, a recalibrar cuando lleguen muestras reales.
 */
export function startExcelIngestWorker(): Promise<string> {
  return registerWorker<ExcelIngestPayload>(
    QUEUES.excelIngest,
    async ({ documentId, companyId }) => {
      try {
        await withCompanyScope(companyId, (db) =>
          db.update(documents).set({ status: 'processing' }).where(eq(documents.id, documentId)),
        );

        const { templateVersion, s3Key, creditRule, locale, baseCurrency, uploadedBy } =
          await withCompanyScope(companyId, async (db) => {
            const [doc] = await db.select().from(documents).where(eq(documents.id, documentId));
            if (!doc) throw new Error(`document ${documentId} not found for company ${companyId}`);

            const [company] = await db.select().from(companies).where(eq(companies.id, companyId));
            if (!company) throw new Error(`company ${companyId} not found`);

            // Antes esto lanzaba si la industria de la empresa no tenía plantilla, y el
            // documento moría en `failed` con un mensaje que el cliente no podía
            // accionar. Ahora `resolveIndustryTemplate` cae al diccionario genérico
            // integrado: la plantilla por industria mejora la clasificación cuando
            // existe, pero ya no es una precondición para ingerir.
            const templateVersion = await resolveIndustryTemplate(db, company.industry);
            /*
             * La moneda base de la EMPRESA, no del archivo. El modelo ya no devuelve la
             * moneda de cada fila: cuando la hoja no trae columna de moneda —el caso normal
             * en los archivos reales— el código la resuelve a esta. Es el mismo default que
             * el modelo aplicaba antes, ahora explícito y probable.
             */
            const baseCurrency = company.baseCurrency;
            if (templateVersion.source === 'default') {
              // No es un error del cliente ni interrumpe nada — es la señal para que
              // el staff sepa qué industria vale la pena curar (panel de plantillas).
              console.info(
                `[excel-ingest] company=${companyId} industry="${company.industry}" sin plantilla propia: usando la genérica integrada`,
              );
            }

            // Frozen once per document (same pattern as fx_rate in promotion.ts) —
            // consistent even if the rule version changes mid-processing.
            const creditRule = await getActiveCreditRule(db, 'excel');

            return {
              templateVersion,
              s3Key: doc.s3Key,
              creditRule,
              locale: company.locale,
              baseCurrency,
              // CU-868krkfrh: a quién se le atribuyen los movimientos de inventario que
              // genere este archivo. El worker no tiene sesión; quien subió el archivo es la
              // atribución honesta, y es la que el historial necesita para poder contestar
              // "¿quién metió estas 211 unidades?".
              uploadedBy: doc.uploadedBy,
            };
          });

        const fileBuffer = await downloadObject(s3Key);
        const workbook = XLSX.read(fileBuffer, { type: 'buffer' });

        // CU-868kh8man: backstop de caps sobre el libro YA parseado. Necesario para
        // `.xls` (binario legacy, sin inspección barata posible en la recepción — ver
        // modules/ingestion/index.ts) y gratis como red de seguridad para el resto:
        // el conteo del intake sale del atributo `dimension` del XML (xlsx) o de un
        // escaneo de bytes (csv), ambos aproximaciones que un archivo raro podría
        // burlar. Va ANTES del bucle de hojas, así que un archivo fuera de norma no
        // gasta ni una llamada a Claude.
        const parsedSheetCount = workbook.SheetNames.length;
        if (parsedSheetCount > intakeConfig.maxSheetsPerWorkbook) {
          throw new Error(
            INTAKE_MESSAGES[locale].tooManySheets(
              intakeConfig.maxSheetsPerWorkbook,
              parsedSheetCount,
            ),
          );
        }
        const parsedRowTotal = workbook.SheetNames.reduce((total, name) => {
          const sheet = workbook.Sheets[name];
          if (!sheet) return total;
          const ref = sheet['!ref'];
          if (!ref) return total;
          const decoded = XLSX.utils.decode_range(ref);
          return total + (decoded.e.r - decoded.s.r + 1);
        }, 0);
        if (parsedRowTotal > intakeConfig.maxRowsPerFile) {
          throw new Error(
            INTAKE_MESSAGES[locale].tooManyRows(intakeConfig.maxRowsPerFile, parsedRowTotal),
          );
        }

        // CU-868kkgypv: qué lotes ya quedaron confirmados por un intento anterior. Una
        // sola query antes del bucle — en la ejecución normal (sin reintentos) el mapa
        // sale vacío y no cambia nada.
        const doneBatches = await withCompanyScope(companyId, async (db) => {
          const rows = await db
            .select({
              sheetName: documentIngestBatches.sheetName,
              batchIndex: documentIngestBatches.batchIndex,
              rowCount: documentIngestBatches.rowCount,
            })
            .from(documentIngestBatches)
            .where(
              and(
                eq(documentIngestBatches.companyId, companyId),
                eq(documentIngestBatches.documentId, documentId),
              ),
            );
          // Clave compuesta (hoja, lote). El separador es NUL porque es el unico byte que
          // no puede aparecer en el nombre de una hoja de Excel: asi "Ventas 1" + lote 2
          // nunca colisiona con "Ventas" + lote "1 2".
          //
          // VA ESCRITO COMO ESCAPE `\u0000`, NO COMO EL BYTE LITERAL, y no es cosmetico:
          // hasta este commit el archivo tenia dos NUL crudos incrustados, y con eso git lo
          // clasificaba como BINARIO (`Bin 16213 -> 16580 bytes` en cada PR que lo tocara).
          // Dos consecuencias, las dos caras: los diffs del worker de mayor riesgo del MVP
          // eran irrevisables en code review, y `grep`/`rg` lo saltaban en silencio —
          // devolvian cero resultados sobre este archivo sin decir por que. El valor en
          // runtime es identico; lo que cambia es que el fuente vuelve a ser texto.
          return new Map(rows.map((r) => [`${r.sheetName}\u0000${r.batchIndex}`, r.rowCount]));
        });

        /**
         * El mapa de columnas que fijó el PRIMER lote de cada hoja. Los demás lotes de esa
         * hoja tienen que coincidir; ver `assertMismoMapa`.
         *
         * `Map` y no una variable por hoja porque los lotes de varias hojas corren mezclados
         * en la misma tanda concurrente. Escribirlo desde varias tareas es seguro: el bucle de
         * eventos de Bun no interrumpe entre el `get` y el `set`.
         */
        /*
         * ═══════════════════════════════════════════════════════════════════════════════════
         * EN QUÉ ORDEN VIENEN DÍA Y MES, DECIDIDO UNA VEZ POR HOJA (2026-08-30)
         * ═══════════════════════════════════════════════════════════════════════════════════
         *
         * `detectarOrdenDeFecha` existía, estaba testeado y documentado con el daño que evita
         * —"el 41 % de sus ingresos quedaba mal fechado y el 59 % no quedaba"— y **no lo
         * llamaba nadie**. El parámetro `ordenDeFecha` de `assemblePayload` no se pasaba desde
         * ningún sitio, así que todo el producto leía `DD/MM` siempre. El arreglo estaba
         * escrito y nunca se conectó.
         *
         * Lo que eso produce es lo peor que puede pasarle a un dato: NO borra ni inventa
         * plata, la MUEVE DE MES. Un libro exportado en `MM/DD/YYYY` entra con el 1 de mayo
         * registrado el 5 de enero — otro trimestre del dashboard, sin que nada falle.
         *
         * Se decide sobre la hoja ENTERA y no lote a lote: es el mismo modo de fallo que
         * `assertMismoMapa` cubre para el mapa de columnas. Dos lotes con órdenes distintos
         * partirían la hoja en dos calendarios.
         *
         * Se mira TODA la fila y no solo la columna que el modelo llamó `date`, por dos
         * motivos: el orden es una propiedad del ARCHIVO (quien lo exportó usó un formato, no
         * uno por columna), y así el orden ya está resuelto antes de la primera llamada al
         * modelo, sin depender de que el mapa exista todavía.
         */
        const ordenDeFechaPorHoja = new Map<string, 'dmy' | 'mdy'>();

        const mapasPorHoja = new Map<string, ColumnMap>();

        /**
         * El perfil de columnas que esta empresa YA tenía para cada hoja (CU-868krmrcj).
         *
         * Se llena después de planear los lotes y se usa para dos cosas distintas:
         *
         *   · Como PISTA para el primer lote de cada hoja. Hoy el primer lote no tiene mapa
         *     canónico —lo está fijando él— así que si no logra ver la columna de monto, todas
         *     SUS filas entran sin monto y se van a revisión con el dato ahí al lado. Con el
         *     perfil, el primer lote arranca sabiendo lo que la empresa ya demostró.
         *   · Para COMPARAR al final y advertir si la estructura se movió.
         *
         * NO se mete en `mapasPorHoja`, y la diferencia importa: ese mapa es el árbitro de
         * conflictos y `fusionarMapaDeColumnas` ABORTA cuando dos lotes se contradicen.
         * Sembrarlo con el perfil convertiría "el modelo hoy opina distinto que la última
         * carga" en una carga abortada — justo el bloqueo duro que Keneth descartó.
         */
        const perfilesPorHoja = new Map<string, PerfilDeColumnas>();

        /**
         * Encabezados por hoja, para poder guardar el perfil al final sin recorrer el libro
         * otra vez. Se llena en la pasada de planificación, que es donde ya se resolvió cuál
         * es la fila de encabezado real.
         */
        const encabezadosPorHoja = new Map<string, unknown[]>();

        /** Avisos para el cliente. Ver `INTAKE_MESSAGES[locale].estructuraCambiada`. */
        const avisos: string[] = [];

        /**
         * Lo que se le va a poder ENSEÑAR al cliente sobre su propio archivo (CU-868krmrcj).
         *
         * Se llena a medida que cada hoja se resuelve, en el mismo sitio donde hoy ya se
         * escribe un `console.info` que rota con los logs de Railway. Ese es el punto: la
         * información existía y se estaba tirando.
         */
        /**
         * Cuánto dinero se lleva una hoja que NO va a producir movimientos.
         *
         * Los cinco descartes de abajo registraban `filas` y nunca el monto, así que el
         * resumen podía decir "descarté 220 filas" y no "descarté Q 2.707.318". Cada bug de
         * ingesta de los últimos meses fue una exclusión o una inclusión equivocada, y el
         * dinero es lo único que las vuelve evidentes de un vistazo — para el dueño, que es
         * quien puede desmentirlas, y para nosotros, que así podemos ordenar por riesgo.
         *
         * ⚠️ Es una ESTIMACIÓN (`lib/sheet-money.ts`): esta hoja nunca tuvo mapa de columnas
         * porque nunca llegó al modelo. No alimenta el ledger ni el cuadre del dinero
         * aterrizado; solo explica. Un fallo acá NO puede tumbar la carga, así que va envuelto.
         */
        const dineroDescartado = (
          rows: unknown[][],
        ): { moneda: string; total: number; filas: number }[] | undefined => {
          try {
            const medicion = medirFilas(rows.slice(1), mapaDeDineroProbable(rows), baseCurrency);
            return medicion.montos.length > 0 ? medicion.montos : undefined;
          } catch {
            return undefined;
          }
        };

        const hojasLeidas: HojaLeida[] = [];

        /**
         * Filas que de verdad llegaron al modelo, por hoja.
         *
         * No se puede derivar de `totalRowsProcessed`, que es del documento entero, ni del
         * tamaño de `rows` en la planificación, que es ANTES de deduplicar. El cliente
         * necesita el número real: "de tu hoja Ventas leímos 520 movimientos".
         */
        const filasPorHoja = new Map<string, number>();

        /**
         * Las mismas filas que se enviaron a clasificar, agrupadas por hoja.
         *
         * Guarda REFERENCIAS a los arrays que el parser ya tiene en memoria, no copias: el
         * costo es una entrada de Map por lote. Sirven para medir cuánto dinero traía la hoja
         * y enseñárselo al cliente en el resumen (`lib/reconciliation.ts`).
         *
         * Se miden al FINAL y no lote a lote a propósito, por el mismo motivo por el que el
         * resumen de columnas se arma al final: `fusionarMapaDeColumnas` completa el mapa lote
         * a lote, así que el mapa del primer lote puede no saber todavía cuál es la columna de
         * monto. Medir con un mapa provisional daría un total que no es el de ninguna columna.
         */
        const filasCrudasPorHoja = new Map<string, unknown[][]>();

        /**
         * Hojas de existencias que van al inventario (CU-868krkfrh), anotadas durante la
         * planificación y aplicadas junto a la promoción.
         *
         * No se aplican al detectarlas porque eso pasa ANTES del chequeo de cancelación: un
         * cliente que cancelara se quedaría con el inventario cambiado y sus movimientos sin
         * promover. Ver la nota del sitio donde se llenan.
         */
        const hojasDeInventario: {
          sheetName: string;
          headerRow: unknown[];
          filas: unknown[][];
          /** Solo el camino serializado lo trae: su hoja no mapea por vocabulario. */
          mapa?: MapaDeInventario | null;
        }[] = [];

        /**
         * El consenso de cada hoja: qué veredicto dio el modelo en sus lotes de sonda.
         *
         * Es lo que decide si el resto de los lotes de esa hoja puede resolverse sin llamar a
         * Claude. Ver `lib/sheet-consensus.ts` para el recibo que lo motiva — 205 de 216
         * llamadas de un archivo real fueron una sola hoja contestando siempre lo mismo.
         */
        const consensos = new Map<string, ConsensoDeHoja>();

        /**
         * Unifica el NOMBRE de las categorías dentro de cada hoja.
         *
         * Uno para todo el documento y no uno por hoja: la clave que usa ya incluye la hoja, y
         * un solo objeto deja el contador de reescrituras del archivo completo en un lugar.
         */
        const canonizador = new CanonizadorDeCategorias();
        const confianzas = new ConfianzaPorHoja();

        /**
         * ═══ DICCIONARIO DE CATEGORÍAS DE ESTA EMPRESA (Keneth–Semi, 2026-08-20) ═══
         *
         * Lo que el modelo ya clasificó para esta empresa en cargas anteriores. Se carga UNA
         * vez por documento —no una consulta por fila: con 18.000 filas serían 18.000 idas a
         * la base para ahorrar llamadas al modelo, o sea cambiar un costo por otro.
         *
         * Se usa para dos cosas distintas y las dos importan:
         *   · APLICAR lo ya sabido, sin volver a preguntar.
         *   · APRENDER lo nuevo al final de la carga, para que la próxima no pregunte.
         */
        const diccionario = await withCompanyScope(companyId, (db) =>
          DiccionarioDeCategorias.cargar(db, companyId),
        );

        /** Lo que esta carga descubrió y hay que guardar. Se escribe UNA vez, al terminar. */
        const aprendidas: ReglaAprendida[] = [];
        /**
         * Categorías cuyo nombre lo fijó el diccionario de la empresa, no este documento.
         *
         * Es la prueba de que el diccionario está haciendo su trabajo entre cargas: cada una
         * de estas es un rubro que NO se partió en dos en el dashboard del cliente.
         */
        let nombresDelDiccionario = 0;

        /** Lotes resueltos sin llamar al modelo, y filas que eso cubrió. Para el log. */
        let lotesCortocircuitados = 0;
        let filasCortocircuitadas = 0;
        /**
         * Filas que el cortocircuito NO se atrevió a clasificar (no parecen movimientos: sin
         * fecha o sin monto legible) y mandó a revisión interna en vez de adivinar.
         */
        let filasAptasFallidas = 0;
        /**
         * Lotes que no llamaron al modelo porque el diccionario de la empresa ya conocía TODOS
         * sus conceptos, y filas que eso cubrió.
         *
         * Se cuentan aparte del cortocircuito de hoja a propósito: son dos mecanismos con
         * distinta condición y distinto alcance, y mezclarlos en un contador dejaría sin forma
         * de saber cuál de los dos está pagando el ahorro de un cliente concreto.
         */
        let lotesPorDiccionario = 0;
        let filasPorDiccionario = 0;

        /** Lo que el archivo traía, por moneda. Alimenta el cuadre de después de promover. */
        const leidoDelArchivo = new Map<string, LeidoDelArchivo>();
        /**
         * Lo mismo, pero SIN sumar entre hojas. Es lo que hace posible el cuadre por hoja: el
         * total del documento se deja engañar por dos errores de signo opuesto —una hoja al
         * doble y otra en cero se cancelan— y esa es la forma exacta de los fallos de
         * composición de esta ingesta. Ver `evaluarCuadrePorHoja` en `lib/cuadre.ts`.
         */
        const leidoPorHoja = new Map<string, { montos: LeidoDelArchivo[]; filas: number }>();
        /** Filas del archivo que se midieron: el denominador de la expansión. */
        let filasMedidas = 0;
        /**
         * Monto de las filas que el modelo declaró `skip` (totales, subtotales, títulos).
         * `medirFilas` las suma a lo leído —y hace bien, el cliente quiere ver lo que su
         * archivo traía— pero nunca iban a llegar al ledger. Ver el bloque donde se acumula.
         */
        const declaradoNoDato = new Map<string, number>();
        /**
         * Hojas que el ESQUEMA del libro demostró que repiten dinero ya registrado en otra, y
         * cuyas filas la ingesta suprimió a propósito. Que no aterricen es lo correcto.
         *
         * Sin esto el cuadre por hoja las reporta `nada_aterrizo` —la forma del fallo más caro—
         * y es un falso positivo GARANTIZADO en todo libro que lleve una hoja de cobros, que
         * son la mayoría. Medido: `12-la-ceiba.xlsx` salió con las tres cifras exactas contra
         * su verdad de campo y el cuadre igual gritó DESCUADRE por `Cobros`.
         */
        const hojasSuprimidas = new Set<string>();
        /**
         * El portón (migración 0042) retuvo la carga: NADA aterrizó en el ledger, y eso es lo
         * correcto, no un descuadre. Sin esta bandera el cuadre reporta `nada_aterrizo` sobre
         * TODA carga nueva — y un detector que grita siempre es uno que nadie mira, que es
         * justamente la lección que este mismo módulo aprendió el 2026-09-01 con la hoja de
         * cobros. El veredicto POR HOJA sigue corriendo entero: compara contra `staging_rows`,
         * que sí está poblado, y es el que de verdad detecta una hoja perdida o contada dos
         * veces. Lo que espera a la confirmación es solo la comparación contra el LEDGER.
         */
        let esperandoConfirmacion = false;
        /** Consulta el esquema y deja registrado el veredicto, en un solo lugar. */
        const marcarSiSuprimida = (hoja: string): boolean => {
          const suprimida = yaRegistradaEnOtraHoja(hoja);
          if (suprimida) hojasSuprimidas.add(hoja);
          return suprimida;
        };

        let totalRowsProcessed = 0;
        // `Set` y no array: un libro de 12 hojas de notas repetiría la misma frase 12
        // veces y el cliente leería un muro. Se deduplica y se muestran las primeras.
        const unusableReasons = new Set<string>();

        /**
         * PRIMERA PASADA: planear todo el trabajo sin llamar a Claude ni tocar la base.
         *
         * Antes esto era un doble bucle que llamaba a Claude en medio, así que el plan y la
         * ejecución estaban entrelazados y no había forma de paralelizar. Separarlos es lo
         * que permite la segunda pasada concurrente, y de paso deja el conteo de las filas ya
         * confirmadas (y el chequeo de plan cambiado) fuera de la parte concurrente, donde
         * razonar sobre él sería más difícil.
         */
        type Pendiente = {
          sheetName: string;
          /** Encabezados de la hoja: van en TODOS sus lotes, no solo en el primero. */
          headerRow: unknown[];
          batchIndex: number;
          batch: unknown[][];
          /** Alineadas con `batch`: se registran en la MISMA transacción que el lote. */
          fingerprints: string[];
        };
        const pendientes: Pendiente[] = [];

        /*
         * ═══ ANTES DE NADA: ¿HAY DOS HOJAS QUE SON EL MISMO DINERO? ═══
         *
         * Un archivo real trae las compras dos veces —una cabecera de órdenes y su detalle de
         * líneas, sumando exactamente lo mismo—. Si las dos producen movimientos, las compras
         * del cliente se cuentan DOS VECES.
         *
         * Se corre sobre las hojas que SOBREVIVEN a los otros filtros, no sobre todas, y esa
         * distinción no es un detalle de eficiencia: comparando todas, un catálogo de productos
         * con totales acumulados "empata" con la hoja de ventas y —por tener menos filas—
         * ganaría, descartando 520 ventas reales. Los otros filtros ya sacaron catálogos y
         * resúmenes; lo que queda son movimientos compitiendo contra movimientos, que es el
         * único caso donde esta comparación significa algo.
         */
        /*
         * ═══ EL AÑO DE UN REPORTE ANCHO SALE DEL LIBRO, NO DE LA HOJA ═══
         *
         * Una matriz de gastos escribe "Enero" y nada más: el año vive en el título, en el
         * nombre de la hoja, o —el dato más fuerte— en las FECHAS que el resto del libro ya
         * trae. Equivocarse manda los gastos del cliente a un año donde su dashboard no los va
         * a buscar nunca, así que se resuelve UNA vez con todo el libro a la vista y no hoja
         * por hoja.
         */
        const fechasDelLibro: unknown[] = [];
        for (const nombre of workbook.SheetNames) {
          const hoja = workbook.Sheets[nombre];
          if (!hoja) continue;
          const crudas: unknown[][] = XLSX.utils.sheet_to_json(hoja, {
            header: 1,
            blankrows: false,
          });
          for (const fila of crudas.slice(1, 40)) {
            for (const celda of fila) if (asDate(celda) !== null) fechasDelLibro.push(celda);
          }
        }

        /*
         * Despivotar es DETERMINISTA y se consulta en las dos pasadas: la primera arma `vivas`
         * (que alimenta el dedup y el esquema del libro) y la segunda procesa. Si la primera no
         * viera la hoja despivotada, el dedup no podría compararla contra nada y una matriz que
         * duplica otra hoja se colaría entera.
         */
        /** Hoja → nota, para el resumen que lee el cliente. */
        const notaDeDespivotado = new Map<string, string>();

        /** Los rubros que nombra una hoja despivotada. Ver `conceptos` en `sheet-duplication`. */
        const conceptosDe = (largas: unknown[][]): ReadonlySet<string> =>
          new Set(
            largas
              .slice(1)
              .map((f) => claveDeConceptoAncho(f[1]))
              .filter((c) => c !== ''),
          );

        /*
         * ═══ EL TEXTO DE LAS HOJAS QUE SÍ PRODUCEN MOVIMIENTOS ═══
         *
         * Es la cuarta guarda del despivotado: si los conceptos de una matriz ancha ya son las
         * CATEGORÍAS de otra hoja, esa matriz es un consolidado de ella y despivotarla contaría
         * doble. Ver el bloque largo en `lib/sheet-unpivot.ts`.
         *
         * Se recorre ANTES de considerar ningún despivotado, y solo las hojas que pasan los
         * filtros por su cuenta: contra TODAS, los derivados del propio libro (un estado de
         * resultados, un punto de equilibrio) nombran los mismos rubros y el solape sale 100 %
         * siempre — la señal se apagaría entera.
         *
         * Se acotan las filas leídas porque lo que interesa son los conceptos DISTINTOS, que
         * son decenas y se repiten desde la primera página; recorrer 18.000 filas para llenar
         * el mismo Set no aporta nada.
         */
        const conceptosPorHoja = new Map<string, Set<string>>();
        for (const nombre of workbook.SheetNames) {
          const hoja = workbook.Sheets[nombre];
          if (!hoja) continue;
          const crudas: unknown[][] = XLSX.utils.sheet_to_json(hoja, {
            header: 1,
            blankrows: false,
          });
          if (crudas.length < 2) continue;
          const desde = crudas.slice(detectarFilaDeEncabezado(crudas));
          if (analizarFormaDeHoja(desde).esReporte) continue;
          if (canSkipSheet(desde[0] ?? [])) continue;
          if (noPuedeProducirMovimientos(desde, asDate, asNumber)) continue;
          const propios = new Set<string>();
          for (const fila of desde.slice(1, 600)) {
            for (const celda of fila) {
              if (typeof celda !== 'string') continue;
              const clave = claveDeConceptoAncho(celda);
              if (clave !== '') propios.add(clave);
            }
          }
          conceptosPorHoja.set(nombre, propios);
        }

        /*
         * ⚠️ SE EXCLUYE LA HOJA QUE SE ESTÁ EVALUANDO, y no es un detalle.
         *
         * La cuarta guarda pregunta "¿mis conceptos ya son las categorías de OTRA hoja?". Si el
         * conjunto incluye los propios, una matriz que sobrevive a los filtros —una chica, de
         * dos o tres rubros, que no llega al umbral de ningún descarte— aporta sus rubros al
         * conjunto y después **se rechaza a sí misma** con 100 % de solape. El síntoma es el
         * peor posible: no se despivota, se va al modelo sin columna de fecha y produce cero
         * movimientos, en silencio.
         */
        const conceptosAjenosA = (hoja: string): Set<string> => {
          const union = new Set<string>();
          for (const [nombre, propios] of conceptosPorHoja) {
            if (nombre === hoja) continue;
            for (const c of propios) union.add(c);
          }
          return union;
        };

        const despivotar = (nombre: string, crudas: unknown[][], rows: unknown[][]) => {
          const filaEnc = crudas.length - rows.length;
          const titulo = crudas
            .slice(0, filaEnc)
            .flat()
            .filter((c) => typeof c === 'string' && c.trim() !== '')
            .join(' ');
          return despivotarReporte(rows, {
            anioPorDefecto: inferirAnio({ titulo, nombreHoja: nombre, fechasDelLibro }),
            titulo,
            conceptosDeMovimientos: conceptosAjenosA(nombre),
          });
        };

        const vivas: {
          nombre: string;
          rows: unknown[][];
          puedeProducirMovimientos: boolean;
          /** Solo para las despivotadas: ver `conceptos` en `lib/sheet-duplication.ts`. */
          conceptos?: ReadonlySet<string>;
        }[] = [];
        for (const nombre of workbook.SheetNames) {
          const hoja = workbook.Sheets[nombre];
          if (!hoja) continue;
          const crudas: unknown[][] = XLSX.utils.sheet_to_json(hoja, {
            header: 1,
            blankrows: false,
          });
          if (crudas.length < 2) continue;
          let desdeEncabezado = crudas.slice(detectarFilaDeEncabezado(crudas));
          /*
           * El despivotado se intenta SIN CONDICIONES; sus guardas deciden, incluida la que
           * rechaza una hoja que ya tiene columna de fecha. Ver el bloque largo de la pasada 2.
           * Acá tiene que verse el MISMO resultado que allá: si no, el dedup y el esquema del
           * libro razonan sobre un conjunto de hojas distinto del que se procesa.
           */
          let conceptosDespivotados: ReadonlySet<string> | undefined;
          const largoDeLaHoja = despivotar(nombre, crudas, desdeEncabezado);
          if (largoDeLaHoja) {
            desdeEncabezado = largoDeLaHoja.rows;
            conceptosDespivotados = conceptosDe(largoDeLaHoja.rows);
          } else if (analizarFormaDeHoja(desdeEncabezado).esReporte) {
            continue;
          }
          if (canSkipSheet(desdeEncabezado[0] ?? [])) continue;
          /*
           * `puedeProducirMovimientos` se calcula ACÁ, con el mismo predicado que el filtro de
           * la segunda pasada, para que el dedup no pueda conservar una hoja que ese filtro va
           * a descartar unas líneas después. Ver "LA CONSERVADA TIENE QUE SOBREVIVIR" en
           * `lib/sheet-duplication.ts`: en el archivo de KapePrueba esa combinación descartó
           * las 481 ventas y las 43 compras del cliente para conservar un resumen de 11 filas
           * que tampoco se procesó.
           */
          // El orden de fecha es una propiedad del ARCHIVO, así que se resuelve acá —con la
          // hoja entera a la vista y antes de la primera llamada al modelo— y no lote a lote.
          ordenDeFechaPorHoja.set(nombre, detectarOrdenDeFecha(desdeEncabezado.slice(1).flat()));
          vivas.push({
            nombre,
            rows: desdeEncabezado,
            ...(conceptosDespivotados ? { conceptos: conceptosDespivotados } : {}),
            puedeProducirMovimientos: !noPuedeProducirMovimientos(
              desdeEncabezado,
              asDate,
              asNumber,
            ),
          });
        }
        const detalleDuplicado = detectarDetalleDuplicado(vivas);

        /*
         * ═══ EL ESQUEMA RELACIONAL DEL LIBRO (2026-08-24) ═══
         *
         * Se calcula sobre las MISMAS hojas vivas que la detección de duplicados, y por el
         * mismo motivo: contra todas las hojas, un catálogo de productos se relacionaría con
         * la hoja de ventas por su SKU y quedaría marcado como tabla de entidades cuando el
         * pre-filtro ya lo había descartado. Acá lo que queda son movimientos compitiendo
         * contra movimientos.
         *
         * Lo que aporta y ningún filtro anterior podía ver: que dos hojas están unidas por
         * IDENTIFICADORES. De ahí sale cuál registra hechos y cuál solo describe cosas. Ver
         * `lib/sheet-relations.ts` para el archivo que lo motivó y lo que costó.
         */
        const esquema: EsquemaDelLibro = analizarEsquema(vivas);

        /*
         * ═══ EL SET DE ENTIDADES SE CORRIGE UNA VEZ, NO EN CADA CONSUMIDOR ═══
         *
         * `analizarEsquema` mira la forma del grafo y nada más: marca como tabla de entidades
         * a toda hoja referenciada que no referencia a nadie. Eso incluye a un libro de
         * VENTAS cuando el archivo no trae hoja de inventario — la hoja queda terminal y el
         * grafo no puede distinguirla de un catálogo (en los dos casos la referenciada es la
         * que CONTIENE a la otra).
         *
         * La primera versión de este arreglo puso el candado `classifySheet !== 'financial'`
         * en el sitio donde se enruta a inventario, y con eso las ventas dejaron de perderse.
         * Pero `esquema.entidades` tiene DOS consumidores, y el otro quedó leyendo el valor
         * equivocado: la regla de "una factura no devenga si su venta ya está registrada"
         * consulta este mismo set, así que en HeladosGT siguió creyendo que `Ventas` era un
         * catálogo y volvió a sumar sus 43 cuentas por cobrar como ingreso — Q 58.334 de más,
         * medido en producción DESPUÉS del primer arreglo.
         *
         * Parchar al consumidor y no a la fuente arregla el caso que uno está mirando y deja
         * al otro roto. Acá se corrige una vez y los dos leen lo mismo.
         */
        const esLibroDeMovimientos = new Map(
          vivas.map((h) => [h.nombre, pareceLibroDeMovimientos(h.rows[0] ?? [])]),
        );
        const entidades = new Set(
          [...esquema.entidades].filter((nombre) => !esLibroDeMovimientos.get(nombre)),
        );
        /*
         * ═══ ¿EL MOVIMIENTO DE ESTA HOJA YA ESTÁ REGISTRADO EN OTRA? ═══
         *
         * Una hoja que apunta a otra hoja de MOVIMIENTOS del mismo libro trae el ESTADO de un
         * hecho que allá ya se registró: una cuenta por cobrar sobre una venta, una cuenta por
         * pagar sobre una compra. Devengar ese hecho otra vez lo cuenta dos veces.
         *
         * `!entidades.has(...)` importa: apuntar a un CATÁLOGO (un vehículo, un producto) no
         * significa que el movimiento esté contado — solo apuntar a algo que produce
         * transacciones lo significa.
         *
         * Vive en una función y no repetido en cada llamada porque tiene TRES consumidores —el
         * camino del modelo y los dos cortocircuitos—, y los dos cortocircuitos **no lo pasaban
         * en absoluto**: un lote resuelto en código derivaba el ingreso de sus facturas aunque
         * la venta ya estuviera registrada. Es el mismo error de "parchar solo un consumidor"
         * que ya costó una vez con `esquema.entidades`.
         */
        const yaRegistradaEnOtraHoja = (hoja: string): boolean =>
          esquema.referencias.some((r) => r.desde === hoja && !entidades.has(r.hacia));

        if (esquema.referencias.length > 0) {
          console.log(
            `[excel-ingest] company=${companyId} esquema del libro: ` +
              esquema.referencias
                .map((r) => `${r.desde}→${r.hacia} (${Math.round(r.cobertura * 100)}%)`)
                .join(', '),
          );
        }

        /** Filas que ya se habían ingerido antes y no vuelven a costar un token. */
        /*
         * DOS contadores, no uno. Se mezclaban en `totalRowsSkipped` y el log lo reportaba
         * todo como "dedup", así que una PRIMERA subida —donde por definición no hay nada
         * deduplicado— informaba "368 filas ya se habían ingerido". Ese es justamente el
         * número con el que se mide si la deduplicación sirve, y mentía.
         *
         * Y separarlos no es solo cosmético: distinguen dos desenlaces opuestos cuando el
         * documento no produce filas. Ver el estado terminal más abajo.
         */
        let totalRowsSkippedPreFiltro = 0;
        let totalRowsSkippedDedup = 0;

        for (const sheetName of workbook.SheetNames) {
          const sheet = workbook.Sheets[sheetName];
          if (!sheet) continue;

          const crudas: unknown[][] = XLSX.utils.sheet_to_json(sheet, {
            header: 1,
            blankrows: false,
          });
          if (crudas.length === 0) continue;
          // `crudas` conserva las filas de título: el despivotado las necesita para sacar el
          // año, y `rows` las pierde en el `splice` de abajo.
          let rows: unknown[][] = [...crudas];

          /*
           * ═══ EL ENCABEZADO NO SIEMPRE ES LA PRIMERA FILA ═══
           *
           * Un Excel hecho por una persona suele empezar con el nombre de la empresa y un
           * título antes de la tabla. Si se asume la fila 0, TODO se desplaza a la vez —el
           * pre-filtro, el mapa de columnas y los índices del modelo— y no falla nada
           * visible: los datos salen de las columnas equivocadas.
           *
           * Se descartan también las filas de ARRIBA del encabezado: son títulos, no
           * movimientos, y mandárselas al modelo es pagar por que conteste que no son datos.
           *
           * Se captura antes de filtrar por huella: en la segunda subida las filas ya están
           * deduplicadas y no llegan a ningún lote, pero el modelo sigue necesitando el
           * encabezado para armar el mapa de columnas.
           */
          const filaEncabezado = detectarFilaDeEncabezado(rows);
          let headerRow = rows[filaEncabezado] ?? [];
          if (filaEncabezado > 0) {
            console.info(
              `[excel-ingest] company=${companyId} hoja "${sheetName}": el encabezado está en ` +
                `la fila ${filaEncabezado}, no en la 0. Se descartan ${filaEncabezado} fila(s) ` +
                `de título.`,
            );
            rows.splice(0, filaEncabezado);
          }

          /*
           * PRE-FILTRO POR ENCABEZADOS, antes que nada. Los archivos reales de los clientes
           * no son exportes contables: son volcados operativos completos. Los tres de
           * prueba traen ocho hojas y CINCO son catálogos —clientes, proveedores, tiendas,
           * inventario, productos— que hoy se le mandan a Claude para que conteste que no
           * son transacciones. Son ~370 de 1.170 filas pagadas para nada.
           *
           * `canSkipSheet` solo descarta con evidencia positiva; la duda va al modelo. El
           * modo de fallo que se evita es silencioso: descartar una hoja financiera haría
           * que esos datos nunca aparecieran en el dashboard del cliente, sin error.
           */
          /*
           * SEGUNDO FILTRO: hojas que no son tablas EN ABSOLUTO.
           *
           * El pre-filtro de catálogos de abajo mira QUÉ describen los encabezados. Este mira
           * la FORMA: una tabla dinámica con un bloque por mes no tiene columnas, tiene
           * layout, y ninguna fila suya es un movimiento. Mandársela al modelo es pagar para
           * que devuelva filas marcadas.
           *
           * Se guarda el motivo en lenguaje del cliente: si el archivo termina sin filas, el
           * mensaje puede decir QUÉ hoja no se entendió en vez de un genérico.
           */
          const yaContada = detalleDuplicado.get(sheetName);
          if (yaContada) {
            totalRowsSkippedPreFiltro += rows.length;
            unusableReasons.add(`la hoja "${sheetName}" ${yaContada}`);
            hojasLeidas.push({
              estado: 'descartada',
              nombre: sheetName,
              motivo: 'duplica_otra_hoja',
              filas: rows.length,
              montos: dineroDescartado(rows),
            });
            console.info(
              `[excel-ingest] company=${companyId} hoja "${sheetName}" descartada por duplicar ` +
                `montos de otra hoja: ${rows.length} filas no van al modelo`,
            );
            continue;
          }

          /*
           * ═══════════════════════════════════════════════════════════════════════════════
           * ¿ES UNA MATRIZ POR PERÍODO QUE SE PUEDE CONVERTIR EN MOVIMIENTOS?
           * ═══════════════════════════════════════════════════════════════════════════════
           *
           * `analizarFormaDeHoja` acierta al decir "esto no es una tabla" y aun así descartarlo
           * PIERDE PLATA REAL: la matriz de gastos operativos de una PYME es la ÚNICA fuente de
           * sus gastos, no hay otra hoja de donde sacarlos. Descartarla deja el dashboard con
           * `GTQ 0.00` en Gastos Operativos y —peor— el resultado del período INFLADO: no es que
           * falte un dato, la cifra que sí se muestra queda mal. Medido: Q 75.465,90 en el
           * archivo real de KapePrueba, que es lo que suma la propia columna `Total` de esa hoja.
           *
           * **Se intenta SIN CONDICIONES**, y eso es deliberado. Antes se intentaba solo cuando
           * otro filtro estaba por descartar la hoja, y ahí se colaba una matriz PEQUEÑA: dos o
           * tres rubros no llegan a las cuatro columnas de período que exige el detector de
           * reportes ni a las cinco filas que exige `noPuedeProducirMovimientos`, así que ningún
           * filtro la tocaba, nadie intentaba despivotarla, y terminaba en el modelo sin columna
           * de fecha — cero movimientos, en silencio. Depender de "algún otro filtro la iba a
           * descartar" obliga a enumerar filtros y umbrales; que la propia función sepa rechazar
           * una hoja que YA tiene columna de fecha la vuelve segura de llamar siempre.
           *
           * `despivotarReporte` es una LISTA BLANCA y devuelve `null` ante cualquier duda: un
           * `Estado_Resultados` o un `Flujo_Caja` tienen la misma forma y despivotarlos
           * duplicaría los ingresos. Cuando dice `null`, la hoja sigue el camino que ya seguía.
           */
          const largo = despivotar(sheetName, crudas, rows);
          if (largo) {
            console.info(
              `[excel-ingest] company=${companyId} hoja "${sheetName}" es una matriz por ` +
                `período: ${largo.motivo}`,
            );
            // No se empuja una entrada de resumen acá: la hoja sigue su curso y empuja la suya
            // de `movimientos` más abajo. Dos entradas la contarían dos veces.
            notaDeDespivotado.set(sheetName, largo.motivo);
            rows = largo.rows;
            headerRow = largo.rows[0] ?? [];
          }

          const forma = analizarFormaDeHoja(rows);
          if (!largo && forma.esReporte) {
            totalRowsSkippedPreFiltro += rows.length;
            unusableReasons.add(`la hoja "${sheetName}" ${forma.motivo}`);
            hojasLeidas.push({
              estado: 'descartada',
              nombre: sheetName,
              motivo: 'reporte',
              filas: rows.length,
              montos: dineroDescartado(rows),
            });
            console.info(
              `[excel-ingest] company=${companyId} hoja "${sheetName}" descartada por forma ` +
                `(${forma.motivo}): ${rows.length} filas no van al modelo`,
            );
            continue;
          }

          /*
           * ═══ UNA TABLA DE ENTIDADES NO PRODUCE MOVIMIENTOS DE DINERO (2026-08-24) ═══
           *
           * Va ANTES de la firma por vocabulario porque cubre justo lo que la firma no puede
           * ver. `firmaDeCatalogo` reconoce el inventario FUNGIBLE de una cafetería (`stock`,
           * `cantidad disponible`, `unidad de medida`); un inventario SERIALIZADO —vehículos
           * por VIN, joyas por certificado, maquinaria por número de serie— no dice ninguna de
           * esas palabras y se colaba entero hacia el modelo.
           *
           * Lo que pasaba entonces no era que la IA leyera mal: leía bien y el código hacía lo
           * incorrecto con lo leído. El modelo veía costo + fecha + producto y concluía, con
           * criterio, que eran costos de venta. CarsGT terminó con 260 vehículos EN STOCK
           * contabilizados como Q 36,4 M de costo —240 de ellos por SEGUNDA vez, porque su
           * costo ya venía en la hoja `Ventas`— y su inventario en cero.
           *
           * La señal es estructural: la clave de esta hoja es única por fila y otra hoja la
           * referencia. Eso es lo mismo en cualquier rubro y no exige conocer el negocio.
           */
          /*
           * ═══ Y NUNCA SOBRE UNA HOJA QUE ES UN LIBRO DE MOVIMIENTOS (2026-08-24) ═══
           *
           * Esta condición se agregó el MISMO día, unas horas después, porque el esquema
           * relacional se comió las ventas de un cliente. Jose subió el archivo de HeladosGT y
           * reportó "ninguna información pasó bien": su hoja `Ventas` —435 filas— se registró
           * como INVENTARIO y su dashboard quedó con Q 58.334 de ingreso contra Q 1.797.772 de
           * gasto. Una heladería con treinta veces más gasto que venta.
           *
           * El agujero es exacto y vale entenderlo, porque el test que lo cubría pasaba: una
           * hoja cuenta como tabla de entidades si otra la referencia y ella no referencia a
           * nadie. En el archivo que motivó el mecanismo eso separaba bien —`Ventas` apuntaba a
           * `Inventario`, así que quedaba excluida— pero ese enlace es una CASUALIDAD de ese
           * libro. En cuanto el libro no tiene hoja de inventario, `Ventas` es terminal en el
           * grafo: nadie la salva y sus ventas se van al stock.
           *
           * La forma del grafo sola no puede distinguirlas, y hay que decirlo: en los dos casos
           * la hoja referenciada es la que CONTIENE a la otra (el inventario contiene lo
           * vendido; las ventas contienen lo que quedó por cobrar). Hace falta una segunda
           * señal, y `classifySheet` ya la tiene medida: `Ventas` da `financial` y el
           * `Inventario` de una concesionaria da `unknown`.
           *
           * Por eso el candado NO es una heurística más: una hoja con columna de fecha Y de
           * monto es un libro de movimientos, y ninguna señal estructural debería poder
           * silenciarla. El costo de equivocarse acá es perder la contabilidad del cliente
           * entera y en silencio — que es exactamente lo que pasó.
           */
          if (entidades.has(sheetName)) {
            const clave = esquema.referencias.find((r) => r.hacia === sheetName)?.haciaColumna;
            const mapaSerie =
              clave === undefined ? null : mapearInventarioSerializado(rows[0] ?? [], clave);

            if (mapaSerie) {
              hojasDeInventario.push({
                sheetName,
                headerRow: rows[0] ?? [],
                filas: rows.slice(1),
                mapa: mapaSerie,
              });
              console.log(
                `[excel-ingest] company=${companyId} hoja "${sheetName}" es tabla de ` +
                  `entidades (${rows.length - 1} filas): va a inventario, no a movimientos`,
              );
              continue;
            }

            /*
             * Es tabla de entidades pero no se puede leer como inventario. NO se manda al
             * modelo igual: eso es exactamente lo que producía el costo falso. Se descarta
             * diciéndolo, que es el mismo trato que recibe cualquier hoja ilegible.
             */
            console.log(
              `[excel-ingest] company=${companyId} hoja "${sheetName}" es tabla de entidades ` +
                `pero no mapea como inventario: ${rows.length - 1} filas no se procesan`,
            );
            totalRowsSkippedPreFiltro += rows.length - 1;
            continue;
          }

          // `rows[0]` ya ES el encabezado real: el corte de arriba quitó los títulos.
          const firma = firmaDeCatalogo(rows[0] ?? []);
          if (firma) {
            /*
             * ═══ EL CATÁLOGO DE EXISTENCIAS NO SE TIRA: ES EL INVENTARIO (CU-868krkfrh) ═══
             *
             * Hasta acá TODO catálogo terminaba igual, en la basura, y eso es lo que producía
             * el reporte "Inventario no carga datos con ningún archivo". En producción se veía
             * en cada carga de cada empresa: 211 filas de inventario descartadas.
             *
             * El pre-filtro sigue intacto —contactos, ubicaciones y productos se siguen
             * descartando, y siguen sin costar un token—; lo único que cambia es que la firma
             * `existencias` tiene ahora a dónde ir.
             *
             * SIN IA, y es deliberado: una hoja de existencias tiene encabezados predecibles,
             * y mandarla al modelo desharía justo lo que el pre-filtro vino a lograr. Si el
             * mapeo por encabezados no alcanza, no se importa y se dice — no se paga por
             * adivinar. Ver `lib/inventory-import.ts`.
             */
            if (firma === 'existencias') {
              /*
               * SE ANOTA, NO SE APLICA TODAVÍA — y esto no es organización, es corrección.
               *
               * La primera versión importaba acá mismo, dentro de la planificación. El
               * problema: la planificación corre ANTES de los lotes y, sobre todo, antes del
               * chequeo de cancelación. Un cliente que cancelara la carga se habría quedado
               * con el inventario ya modificado mientras sus movimientos —por decisión
               * explícita de este worker— NO se promueven. "Cancelé y aun así me cambió el
               * stock" es exactamente la sorpresa que el botón de cancelar existe para
               * evitar.
               *
               * Aplicarlo junto a la promoción alinea las dos mitades del archivo: o entra
               * todo lo que el cliente subió, o no entra nada.
               */
              hojasDeInventario.push({ sheetName, headerRow: rows[0] ?? [], filas: rows.slice(1) });
              // Sus filas NO cuentan como descartadas por el pre-filtro: se van a procesar,
              // solo que por otro camino. Sumarlas ahí haría mentir a la métrica de descarte.
              continue;
            }

            totalRowsSkippedPreFiltro += rows.length;
            hojasLeidas.push({
              estado: 'descartada',
              nombre: sheetName,
              motivo: 'catalogo',
              filas: rows.length,
              montos: dineroDescartado(rows),
            });
            console.info(
              `[excel-ingest] company=${companyId} hoja "${sheetName}" descartada por encabezados (catálogo, no movimientos): ${rows.length} filas no van al modelo`,
            );
            continue;
          }

          /*
           * ═══ TERCER FILTRO: NI UNA SOLA FECHA EN TODA LA HOJA ═══
           *
           * El pre-filtro de arriba reconoce vocabulario de contacto, y un catálogo moderno no
           * trae nada de eso — `Clientes: ID · Nombre · Industria · Plan`, `Rutas`, `Flota`.
           * Los tres se iban al modelo. Encontrado en un corpus de diez libros reales
           * (2026-08-25): la mitad de los archivos traía al menos uno.
           *
           * NO rompe el sesgo de "ante la duda, al modelo", porque no descarta nada que hoy
           * sobreviva: un movimiento sin fecha lo rechaza `staging-rules` por `invalid_date` y
           * queda en revisión interna. Lo único que cambia es dónde se detiene — antes de
           * pagar la llamada en vez de después.
           *
           * Y se juzga por el CONTENIDO de las celdas, no por los nombres de columna: una hoja
           * de movimientos cuya columna se llame `Emisión` o `Corte` no tiene ninguna palabra
           * que el vocabulario reconozca, pero sus celdas siguen trayendo fechas.
           */
          if (noPuedeProducirMovimientos(rows, asDate, asNumber)) {
            totalRowsSkippedPreFiltro += rows.length;
            hojasLeidas.push({
              estado: 'descartada',
              nombre: sheetName,
              // Ya no dice `catalogo`: acá lo único que sabemos es que no se le pudo leer una
              // columna de fecha con dinero al lado. Decirle al cliente que su hoja "describe
              // clientes, productos o proveedores" cuando no es cierto le enseña a no creerle
              // al resumen — y este es el filtro que dejó el dashboard de KapePrueba en cero.
              motivo: 'sin_fecha_ni_monto',
              filas: rows.length - 1,
              montos: dineroDescartado(rows),
            });
            console.info(
              `[excel-ingest] company=${companyId} hoja "${sheetName}" descartada: no tiene ` +
                `una columna de fecha con dinero en otra columna, así que no puede producir ` +
                `movimientos ` +
                `(${rows.length - 1} filas no van al modelo)`,
            );
            continue;
          }

          /*
           * DEDUPLICACIÓN ANTES DE LA IA (migración 0023). Es lo primero que pasa con las
           * filas, y el orden importa: filtrar acá reduce el número de LOTES, así que
           * ahorra costo y tiempo a la vez. Deduplicar más adelante —al insertar en
           * staging o al promover— no ahorraría nada: la fila ya se le habría mostrado al
           * modelo y ya estaría pagada.
           *
           * SE EXCLUYEN LAS HUELLAS DE ESTE MISMO DOCUMENTO, y no es un detalle: la
           * reanudación por lote de más abajo exige que el lote `n` cubra las MISMAS filas
           * entre intentos. Si el intento 1 registró huellas y el intento 2 las filtrara,
           * el plan de lotes cambiaría y la guarda de reanudación abortaría la carga.
           * Filtrando solo contra OTROS documentos, el plan es estable entre reintentos y
           * sigue siendo correcto para un archivo nuevo.
           */
          const huellas = fingerprintSheet({ companyId, sheetName, rows });
          const yaVistas = await withCompanyScope(companyId, (db) =>
            findSeenFingerprints(db, companyId, documentId, huellas),
          );

          const filtradas: unknown[][] = [];
          const huellasFiltradas: string[] = [];
          for (let i = 0; i < rows.length; i++) {
            if (yaVistas.has(huellas[i]!)) {
              totalRowsSkippedDedup++;
              continue;
            }
            filtradas.push(rows[i]!);
            huellasFiltradas.push(huellas[i]!);
          }
          if (filtradas.length === 0) {
            // Toda la hoja ya se había ingerido. NO es un descarte del pre-filtro: es el caso
            // de éxito de la deduplicación, y cuesta USD 0. Se distingue en el resumen porque
            // para el cliente son cosas muy distintas — "no lo leí" contra "ya lo tenía".
            hojasLeidas.push({
              estado: 'descartada',
              nombre: sheetName,
              motivo: 'ya_ingerida',
              filas: rows.length,
              montos: dineroDescartado(rows),
            });
            continue;
          }

          // A partir de acá se trabaja SOLO con lo nuevo.
          rows.length = 0;
          rows.push(...filtradas);

          // CU-868kmwdqu: el tamaño de lote sale del presupuesto de tokens de SALIDA, no
          // solo del conteo de filas. El cap por filas de CU-868kfv972 sigue siendo el
          // techo; manda el menor de los dos. Ver lib/sheet-batching.ts.
          const batchSize = planBatchSize(rows);

          const batches = chunk(rows, batchSize);
          for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
            const batch = batches[batchIndex]!;
            const batchFingerprints = huellasFiltradas.slice(
              batchIndex * batchSize,
              batchIndex * batchSize + batch.length,
            );

            // Reanudar, no reprocesar: el lote ya confirmado se salta ANTES de la
            // llamada a Claude. Eso es lo que evita el cobro doble, el costo duplicado
            // y el gasto real en Anthropic. Su conteo de filas sale de la marca, para
            // que `documents.row_count` siga siendo el del documento completo.
            const alreadyDone = doneBatches.get(`${sheetName}\u0000${batchIndex}`);
            if (alreadyDone !== undefined) {
              // CU-868kmwdqu — la reanudación asume que el lote `n` de esta ejecución
              // cubre las MISMAS filas que el lote `n` de la anterior. Deja de ser
              // cierto si el plan de lotes cambia entre intentos: un deploy que ajusta
              // el presupuesto de salida, o una `INTAKE_*` movida en Railway. Saltarse
              // el índice `n` se saltaría entonces filas distintas de las ya
              // procesadas, y el documento quedaría con huecos o duplicados —en
              // silencio, y con la promoción dándolo por bueno. Se falla en voz alta.
              if (alreadyDone !== batch.length) {
                throw new Error(
                  `El plan de lotes cambió para la hoja "${sheetName}" lote ${batchIndex}: el intento anterior confirmó ${alreadyDone} filas y este calculó ${batch.length}. Reanudar mezclaría filas distintas; revertir el documento y volver a subirlo.`,
                );
              }
              totalRowsProcessed += alreadyDone;
              continue;
            }

            pendientes.push({
              sheetName,
              headerRow,
              batchIndex,
              batch,
              fingerprints: batchFingerprints,
            });
            encabezadosPorHoja.set(sheetName, headerRow);
            filasPorHoja.set(sheetName, (filasPorHoja.get(sheetName) ?? 0) + batch.length);
            const crudas = filasCrudasPorHoja.get(sheetName);
            if (crudas) crudas.push(...batch);
            else filasCrudasPorHoja.set(sheetName, [...batch]);
          }
        }

        /*
         * ═══ EL PERFIL DE LA EMPRESA, ANTES DE LLAMAR AL MODELO (CU-868krmrcj) ═══
         *
         * Va acá y no dentro del bucle de planificación por una razón concreta: en el bucle
         * habría una consulta por hoja INTERCALADA con el resto del trabajo, y varias de esas
         * hojas terminan descartadas por el pre-filtro o por dedup. Acá ya se sabe qué hojas
         * de verdad van al modelo, así que se consulta solo por esas.
         *
         * Una consulta por hoja y no una sola con `IN`: son como mucho 30 hojas por libro (el
         * cap de `maxSheetsPerWorkbook`), la consulta pega en el índice
         * `(company_id, header_hash, version DESC)`, y armar el `IN` obligaría a mapear los
         * resultados de vuelta a su hoja por hash, que es más código para ahorrar milisegundos
         * en un job que dura minutos.
         *
         * Si esto falla NO se cae la carga: el perfil es una optimización y una advertencia,
         * no un requisito. Perderlo significa trabajar como se trabajaba antes de este ticket.
         */
        await withCompanyScope(companyId, async (db) => {
          for (const [sheetName, headerRow] of encabezadosPorHoja) {
            const perfil = await perfilVigente(db, companyId, headerRow);
            if (perfil) perfilesPorHoja.set(sheetName, perfil);
          }
        }).catch((err) => {
          console.error(
            `[excel-ingest] company=${companyId} no se pudieron leer los perfiles de columnas ` +
              `(se sigue sin ellos):`,
            err,
          );
        });

        /**
         * ¿El cliente canceló mientras corríamos?
         *
         * Se consulta ANTES de cada llamada a Claude, que es el único momento en que la
         * cancelación puede evitar un gasto. No se puede interrumpir una llamada ya en vuelo
         * ni abortar una transacción desde otra request, así que la cancelación es
         * cooperativa por necesidad: acota el gasto, no lo corta en seco.
         *
         * Consulta propia y corta a propósito: el estado lo cambia OTRA request, así que
         * leerlo dentro de la transacción larga del lote devolvería el valor de cuando ésta
         * empezó y la cancelación no se vería nunca.
         */
        async function cancelado(): Promise<boolean> {
          const [d] = await withCompanyScope(companyId, (db) =>
            db
              .select({ status: documents.status })
              .from(documents)
              .where(eq(documents.id, documentId)),
          );
          return d?.status === 'cancelled';
        }

        /**
         * Los cuatro efectos de un lote, en UNA transacción: la marca de progreso, el uso de
         * IA (si hubo llamada), las filas de staging y las huellas.
         *
         * Está extraída de `procesarLote` porque ahora hay DOS caminos que llegan al mismo
         * final —el lote que va a Claude y el que se resuelve por consenso de la hoja— y la
         * atomicidad de los cuatro efectos no puede depender de cuál de los dos fue. Duplicar
         * este bloque habría sido duplicar la reanudación, el ledger append-only y el débito
         * de créditos, que es exactamente donde una divergencia no se nota hasta que cobra
         * dos veces.
         */
        async function confirmarLote({
          sheetName,
          batchIndex,
          batch,
          fingerprints,
          rows,
          uso,
        }: {
          sheetName: string;
          batchIndex: number;
          batch: unknown[][];
          fingerprints: string[];
          rows: Awaited<ReturnType<typeof classifySheetRows>>['rows'];
          /** `null` = este lote no llamó a Claude (cortocircuito). */
          uso: {
            model: string;
            inputTokens: number;
            outputTokens: number;
            cacheReadTokens: number;
            cacheCreationTokens: number;
          } | null;
        }): Promise<void> {
          await withCompanyScope(companyId, async (db) => {
            // La marca va en la MISMA transacción que los tres efectos de abajo: o se
            // confirma todo el lote (y el reintento lo salta) o no queda nada (y el
            // reintento lo rehace entero). `onConflictDoNothing` cubre el caso de dos
            // ejecuciones solapadas del mismo job — el árbitro es el índice único.
            const [claimed] = await db
              .insert(documentIngestBatches)
              .values({ companyId, documentId, sheetName, batchIndex, rowCount: batch.length })
              .onConflictDoNothing()
              .returning({ id: documentIngestBatches.id });
            if (!claimed) return;

            /*
             * SOLO si hubo llamada. Un lote resuelto por cortocircuito (ver
             * `lib/sheet-consensus.ts`) no habló con Anthropic, así que no le corresponde una
             * fila acá: `ai_usage_events` es el registro de las llamadas a Claude —una por
             * llamada, dice CLAUDE.md— y no un contador de lotes. Inventarle una fila con cero
             * tokens haría que el panel de costos mostrara llamadas que nunca existieron, y es
             * justo en ese panel donde se mide si el ahorro funcionó.
             */
            if (uso) {
              await insertAiUsageEvent(db, {
                companyId,
                kind: 'excel',
                refId: documentId,
                model: uso.model,
                inputTokens: uso.inputTokens,
                outputTokens: uso.outputTokens,
                cacheReadTokens: uso.cacheReadTokens,
                cacheCreationTokens: uso.cacheCreationTokens,
                billableUnits: batch.length,
              });
            }
            // El nombre de la hoja viaja con las filas (migración 0039): es lo que permite
            // cuadrar POR HOJA. Sin él, una hoja que aterriza el doble y otra que aterriza
            // cero se cancelan en el total del documento y la carga parece correcta.
            await insertStagingRows(db, companyId, documentId, rows, sheetName);

            /*
             * Las huellas se registran en la MISMA transacción que el resto del lote. Si
             * se registraran antes de llamar a Claude, un fallo dejaría las filas marcadas
             * como vistas SIN haberse procesado: se perderían para siempre, porque la
             * próxima carga las filtraría. Registrarlas al confirmar significa que una
             * huella existe si y solo si su fila llegó a staging.
             *
             * ═══ SE REASIGNA LA HUELLA, NO SE IGNORA EL CONFLICTO (migración 0031) ═══
             *
             * Antes iba `onConflictDoNothing`, y eso abría el fallo OPUESTO al que reportó
             * Jose. Recorrido completo, encontrado corriendo el ciclo con el worker de verdad
             * (`tests/integration/revert-y-recarga-e2e.test.ts`):
             *
             *   1. `doc1` procesa y registra sus huellas apuntando a `doc1`.
             *   2. El cliente revierte `doc1`.
             *   3. `doc2` sube el mismo archivo. Ya no se filtra (correcto), así que procesa —
             *      pero su INSERT choca con la fila existente y `DoNothing` la deja apuntando
             *      a `doc1`.
             *   4. `doc3` sube otra vez: la huella sigue señalando a `doc1`, que sigue
             *      revertido, así que tampoco bloquea. Y así para siempre.
             *
             * O sea: revertir una vez desactivaba la deduplicación de ese archivo de forma
             * PERMANENTE, y el cliente que resube su contabilidad cada semana volvía a pagarla
             * entera cada semana sin que nada lo dijera.
             *
             * Al reasignar, el invariante vuelve a ser cierto: la huella apunta al documento
             * cuyos datos están VIVOS. Y el UPDATE solo puede darse en ese caso por
             * construcción — si el documento apuntado estuviera vivo, `findSeenFingerprints`
             * habría filtrado la fila y no se llegaría hasta acá.
             *
             * Sigue cubriendo lo de antes: dos ejecuciones solapadas del mismo job y una fila
             * que aparezca en dos hojas con el mismo contenido.
             */
            if (fingerprints.length > 0) {
              await db
                .insert(ingestedRows)
                .values(
                  fingerprints.map((fingerprint) => ({
                    companyId,
                    fingerprint,
                    firstSeenDocumentId: documentId,
                    sheetName,
                  })),
                )
                .onConflictDoUpdate({
                  target: [ingestedRows.companyId, ingestedRows.fingerprint],
                  set: { firstSeenDocumentId: documentId, sheetName },
                });
            }

            /*
             * ═══ EL CRÉDITO NO SE COBRA ACÁ: SE COBRA UNA VEZ POR CARGA ═══
             *
             * Hasta el 2026-08-24 este bloque debitaba por LOTE. Con la regla activa en 25
             * créditos, un archivo de 77 lotes cobraba 1.925 por una sola carga y dejaba a la
             * empresa en negativo con su primer upload. Ver `cargaYaDebitada` para el detalle
             * medido y por qué el débito se movió antes del bucle de lotes.
             */
          });

          totalRowsProcessed += batch.length;
        }

        /** Un lote: la llamada a Claude y la transacción que confirma sus cuatro efectos. */
        async function procesarLote({
          sheetName,
          headerRow,
          batchIndex,
          batch,
          fingerprints,
        }: Pendiente): Promise<void> {
          /*
           * El chequeo va acá y no al principio del job: un archivo grande son minutos, y lo
           * que hay que evitar es la PRÓXIMA llamada, no la primera. Los lotes ya confirmados
           * se quedan — se pagaron, y sus huellas hacen que volver a subir el archivo cobre
           * solo lo que falta.
           */
          if (await cancelado()) return;

          const result = await classifySheetRows({
            templateVersion,
            sheetName,
            rows: batch,
            /*
             * Esta hoja apunta a otra hoja de MOVIMIENTOS del mismo libro, o sea que sus
             * facturas ya tienen su venta registrada allá. `!entidades.has` importa: apuntar a
             * un catálogo (un vehículo, un producto) no significa que el ingreso esté contado
             * — solo apuntar a algo que produce transacciones lo significa.
             */
            ventaYaRegistradaEnOtraHoja: marcarSiSuprimida(sheetName),
            /*
             * La misma condición para el otro lado del balance. Una hoja de cuentas por pagar
             * que apunta a la de compras trae deudas cuyo COSTO ya está registrado allá, y
             * derivarlo otra vez lo cuenta dos veces — exactamente el caso que la regla de la
             * factura emitida ya cubre para los ingresos.
             *
             * Es el MISMO predicado a propósito: la señal es "esta hoja apunta a otra que
             * produce movimientos", y esa señal no cambia según el signo del dinero.
             */
            compraYaRegistradaEnOtraHoja: marcarSiSuprimida(sheetName),
            headerRow,
            baseCurrency,
            /*
             * Lo que la hoja ya sabe, para que este lote arme sus valores con eso y no con
             * sus propios nulos. Sin esto, un lote que no distinguió la columna de monto
             * dejaba TODAS sus filas sin monto — se marcaban `invalid_amount` y se iban a
             * revisión manual, con el dato ahí al lado en la celda.
             */
            /*
             * CU-868krmrcj: si esta hoja todavía no fijó su mapa —o sea, este ES el primer
             * lote— se le pasa el PERFIL de la empresa. Sin él, el primer lote de cada hoja
             * es el único que trabaja a ciegas, y si no distingue la columna de monto, todas
             * sus filas entran sin monto.
             *
             * Es una pista, no una orden: el modelo puede devolver un mapa distinto y ese es
             * el que manda (y el que dispara la advertencia al final). El perfil nunca aborta
             * una carga.
             */
            columnsCanonicas:
              mapasPorHoja.get(sheetName) ?? perfilesPorHoja.get(sheetName)?.columnMap,
            // Ver el bloque de `ordenDeFechaPorHoja`: se decide por HOJA, no por lote.
            ordenDeFecha: ordenDeFechaPorHoja.get(sheetName),
            /*
             * Que este lote use el nombre de categoría que ya usó su hoja. Sin esto, dos lotes
             * de `Ventas` devolvieron `sales`, `ventas` y `product_sales` para el mismo
             * concepto y el cliente terminó con tres rubros donde hay uno.
             */
            /*
             * ═══ DOS NIVELES, Y EL ORDEN IMPORTA (Keneth–Semi, 2026-08-20) ═══
             *
             * El canonizador unifica DENTRO de la hoja: sin él, dos lotes de `Ventas`
             * devolvieron `sales`, `ventas` y `product_sales` para el mismo concepto y el
             * cliente terminó con tres rubros donde hay uno.
             *
             * Pero eso vive en memoria y muere con la carga. La semana siguiente el modelo
             * puede bautizar el mismo concepto distinto otra vez, y el cliente vuelve a tener
             * dos rubros — el mismo bug, un nivel más arriba.
             *
             * El diccionario va PRIMERO justamente por eso: si esta empresa ya tiene un
             * nombre para este concepto, ese nombre gana, y su dashboard dice lo mismo esta
             * semana y la próxima. Solo cuando el diccionario no lo conoce decide el
             * canonizador, y su elección se guarda al final para que la próxima carga sí lo
             * encuentre.
             */
            canonizarCategoria: (entity, type, category) => {
              const delDiccionario = diccionario.buscar(category);
              if (delDiccionario !== null && delDiccionario.category !== category) {
                nombresDelDiccionario++;
                return delDiccionario.category;
              }
              return canonizador.canonizar(sheetName, entity, type, category);
            },
            /*
             * Nivela la confianza que el modelo dio UNIFORME a todo un lote. Sobre filas
             * indistinguibles de `Ventas` devolvió 0,92 · 0,75 · 0,60 según el lote, y con el
             * umbral en 0,7 eso mandó 148 filas buenas a revisión interna. Ver `ConfianzaPorHoja`.
             */
            nivelarConfianza: (veredictos) => confianzas.registrarLote(sheetName, veredictos),
          });

          // Se recoge, no se actúa todavía: una hoja ilegible en un libro que por lo
          // demás trae datos buenos no debe tumbar la carga. Lo que decide el estado
          // terminal es si el documento COMPLETO no produjo ninguna fila (abajo).
          if (!result.sheetUsable && result.unusableReason) {
            unusableReasons.add(result.unusableReason);
          }

          /*
           * La evidencia para decidir si esta hoja es homogénea. Se acumula acá —dentro del
           * lote que YA pagó— y se lee al terminar la sonda: es el único punto donde se sabe
           * qué contestó el modelo sin haber gastado nada extra por preguntarlo.
           */
          let consenso = consensos.get(sheetName);
          if (!consenso) {
            consenso = new ConsensoDeHoja();
            consensos.set(sheetName, consenso);
          }
          consenso.registrarLote(result.veredictos);

          /*
           * ═══ LO QUE EL MODELO DECLARÓ QUE NO ERA UN DATO, PARA EL CUADRE ═══
           *
           * Un renglón de TOTAL o un subtotal trae un monto legible, así que `medirFilas` lo
           * SUMA a lo leído del archivo — y hace bien: el resumen que ve el cliente debe decir
           * lo que el archivo traía, no lo que sobrevivió a los filtros.
           *
           * Pero el cuadre compara contra el LEDGER, y esas filas nunca iban a llegar ahí. Sin
           * descontarlas, una hoja con un subtotal de Q 999.999 reporta que "falta el 89 % de
           * la contabilidad" cuando el pipeline hizo exactamente lo correcto. Medido en el test
           * de integración: el detector marcaba `falta 11 %` sobre una carga sana.
           *
           * Se descuenta SOLO lo que el modelo declaró `skip` explícitamente. Una fila que se
           * marcó por `invalid_date` o que se fue a revisión NO se descuenta: esa sí es plata
           * que el cliente esperaba ver y no está, y esconderla dejaría al detector ciego
           * justo ante el caso que más importa.
           */
          for (const [i, v] of result.veredictos.entries()) {
            if (v.e !== 'skip') continue;
            const fila = batch[i];
            if (!fila) continue;
            const medicionSkip = medirFilas([fila], result.columns, baseCurrency);
            for (const m of [...medicionSkip.montos, ...medicionSkip.costos]) {
              declaradoNoDato.set(m.moneda, (declaradoNoDato.get(m.moneda) ?? 0) + m.total);
            }
          }

          /*
           * ═══ LO QUE ESTA CARGA APRENDIÓ (Keneth–Semi, 2026-08-20) ═══
           *
           * Se empareja cada veredicto con la DESCRIPCIÓN de su fila para guardar la regla
           * "este concepto es esta categoría". El emparejamiento es por ÍNDICE, y eso es
           * seguro acá por una razón concreta: `hayDesplazamiento` ya abortó el lote si el
           * modelo numeró corrido, así que en este punto la posición i del veredicto es la
           * fila i del lote. Sin esa garantía, esto guardaría reglas cruzadas — el concepto
           * de una fila con la categoría de la siguiente.
           *
           * Solo se recoge, no se escribe: la escritura va UNA vez al final del documento.
           * Escribir por lote dejaría reglas a medias si la carga se cancela o falla, y una
           * tabla append-only no las puede limpiar después.
           */
          /*
           * La MISMA columna que usa `resolverLoteConDiccionario` para buscar, y tiene que
           * serlo: si acá se aprendiera por `description` y allá se buscara por `product`, la
           * regla se guardaría bajo una clave que nadie va a consultar nunca. Con `description`
           * a secas, además, el diccionario no aprendía NADA en las 54 hojas de producción que
           * no la traen — entre ellas `Ventas`, la más grande de cualquier archivo.
           */
          const iDescripcion =
            result.columns.description ?? result.columns.product ?? result.columns.counterparty;
          if (iDescripcion !== null && iDescripcion !== undefined) {
            for (const [i, v] of result.veredictos.entries()) {
              // `skip` no enseña nada: el modelo dijo explícitamente que esa fila no es un
              // movimiento, y guardarla como regla clasificaría de más la próxima vez.
              if (v.e === 'skip' || v.c === null) continue;
              // Confianza baja va a revisión interna, así que tampoco es algo que el sistema
              // pueda dar por sabido — guardarlo sería propagar una duda como certeza.
              if (v.cf < 0.7) continue;
              const texto = batch[i]?.[iDescripcion];
              if (texto === undefined) continue;
              aprendidas.push({ texto, entity: v.e, type: v.t, category: v.c });
            }
          }

          /*
           * ANTES de la transacción, a propósito: si dos lotes de la misma hoja leyeron
           * columnas distintas, aplicarlos dejaría media hoja con los valores de otra columna
           * —montos plausibles, ningún error— y comprobarlo después ya sería tarde, porque las
           * filas estarían insertadas.
           *
           * El primer lote de la hoja fija el mapa canónico. Que gane el primero y no la
           * mayoría es deliberado: la mayoría exigiría esperar a que terminen todos los lotes,
           * que es exactamente el momento en que ya no se puede evitar el daño.
           */
          const canonico = mapasPorHoja.get(sheetName);
          if (canonico) {
            // Lanza SOLO si dos lotes ponen la misma columna en posiciones distintas. Un
            // `valor vs null` no es contradicción: es un lote que no pudo verla, y el
            // fusionado se queda con el que sí. Ver `fusionarMapaDeColumnas`.
            mapasPorHoja.set(
              sheetName,
              fusionarMapaDeColumnas(sheetName, canonico, result.columns),
            );
          } else {
            mapasPorHoja.set(sheetName, result.columns);
          }

          await confirmarLote({
            sheetName,
            batchIndex,
            batch,
            fingerprints,
            rows: result.rows,
            uso: {
              model: result.model,
              inputTokens: result.inputTokens,
              outputTokens: result.outputTokens,
              cacheReadTokens: result.cacheReadTokens,
              cacheCreationTokens: result.cacheCreationTokens,
            },
          });
        }

        /**
         * Un lote resuelto SIN llamar al modelo, aplicando el veredicto que su hoja ya
         * estableció en la sonda.
         *
         * ═══ POR QUÉ ESTO NO ES "ADIVINAR" ═══
         *
         * El veredicto no lo inventa el código: lo dijo el modelo, sobre filas de esta misma
         * hoja, leídas con este mismo mapa de columnas, en al menos `SONDA_LOTES` llamadas
         * separadas que coincidieron entre sí en más del 98 %. Lo único que hace acá el código
         * es dejar de pagar por la repetición — la misma jugada que ya se hizo con los VALORES
         * de la fila (`lib/row-assembly.ts`: "eso no es criterio, es indexar").
         *
         * Y las filas no entran a ciegas: cada una tiene que parecerse a las que el modelo
         * bendijo (`filaAptaParaCortocircuito`). La que no se parece va a revisión interna con
         * confianza 0, igual que hace `classifySheetRows` con la fila que no logró clasificar.
         * Nunca se descarta ninguna.
         */
        async function procesarLoteLocal({
          pendiente: { sheetName, batchIndex, batch, fingerprints },
          veredicto,
          columnas,
        }: {
          pendiente: Pendiente;
          veredicto: VeredictoDominante;
          columnas: ColumnMap;
        }): Promise<void> {
          // Mismo chequeo que el camino con modelo. Acá no evita un gasto con Anthropic, pero
          // sí evita seguir escribiendo filas de un documento que el cliente ya canceló.
          if (await cancelado()) return;

          const porIndice = new Map<number, VeredictoCrudo>();
          let noAptas = 0;
          for (let i = 0; i < batch.length; i++) {
            if (filaAptaParaCortocircuito(batch[i]!, columnas)) {
              porIndice.set(i, {
                i,
                e: veredicto.targetEntity,
                t: veredicto.type,
                c: veredicto.category,
                cf: veredicto.confidence,
              });
              continue;
            }
            /*
             * No se parece a un movimiento (le falta la fecha o el monto en las columnas que el
             * mapa señala): un título de sección, un subtotal, una fila de cierre. Se arma
             * igual, con lo que el mapa permita leer y `confidence: 0`, así que `staging-rules`
             * la marca y cae en revisión interna.
             *
             * Es exactamente lo que hace `classifySheetRows` con la fila que el modelo no
             * cubrió, y por el mismo motivo: un humano mirando una fila de más es un costo
             * visible y acotado; una fila perdida es un error silencioso en los números de un
             * cliente.
             */
            porIndice.set(i, { i, e: 'transaction', t: null, c: null, cf: 0 });
            noAptas++;
          }

          const rows = construirFilas(
            porIndice,
            {
              rows: batch,
              baseCurrency,
              ordenDeFecha: ordenDeFechaPorHoja.get(sheetName),
              ventaYaRegistradaEnOtraHoja: marcarSiSuprimida(sheetName),
              compraYaRegistradaEnOtraHoja: marcarSiSuprimida(sheetName),
            },
            columnas,
          );
          await confirmarLote({
            sheetName,
            batchIndex,
            batch,
            fingerprints,
            rows,
            // Sin llamada a Claude: no hay uso de IA que registrar. Eso ES el ahorro.
            uso: null,
          });

          lotesCortocircuitados++;
          filasCortocircuitadas += batch.length - noAptas;
          filasAptasFallidas += noAptas;
        }

        /**
         * Un lote resuelto SIN llamar al modelo porque el diccionario ya conocía todas sus
         * filas — el ahorro que el acuerdo con Semi dejó pendiente el 2026-08-20.
         *
         * ═══ EN QUÉ SE DIFERENCIA DEL CORTOCIRCUITO DE HOJA ═══
         *
         * `procesarLoteLocal` aplica UN veredicto a todo el lote, porque su hoja resultó
         * homogénea. Acá cada fila trae el SUYO, sacado de su propio concepto. Esa es toda la
         * diferencia, y es la que hace que sirva justo donde el consenso no llega:
         * `Gastos_Operativos` tiene 13 categorías y la más frecuente cubre el 11 %, así que
         * nunca va a ser homogénea — pero sus conceptos son los mismos proveedores de la
         * semana pasada.
         *
         * Los candados viven en `resolverLoteConDiccionario`, y son la razón por la que acá no
         * hay filas "no aptas" que mandar a revisión: si una sola fila del lote no está
         * cubierta o no parece un movimiento, el lote ENTERO se fue al modelo. Esto solo corre
         * cuando ya no queda nada que preguntar.
         */
        async function procesarLotePorDiccionario({
          pendiente: { sheetName, batchIndex, batch, fingerprints },
          porIndice,
          columnas,
        }: {
          pendiente: Pendiente;
          porIndice: Map<number, VeredictoCrudo>;
          columnas: ColumnMap;
        }): Promise<void> {
          if (await cancelado()) return;

          const rows = construirFilas(
            porIndice,
            {
              rows: batch,
              baseCurrency,
              ordenDeFecha: ordenDeFechaPorHoja.get(sheetName),
              ventaYaRegistradaEnOtraHoja: marcarSiSuprimida(sheetName),
              compraYaRegistradaEnOtraHoja: marcarSiSuprimida(sheetName),
            },
            columnas,
          );
          await confirmarLote({
            sheetName,
            batchIndex,
            batch,
            fingerprints,
            rows,
            // Sin llamada: no hay `ai_usage_events` que escribir. El crédito SÍ se debita
            // igual (lo hace `confirmarLote`), y eso es decisión de producto, no del worker:
            // los créditos miden el trabajo hecho para el cliente, no nuestro costo con
            // Anthropic. Cambiarlo movería el precio.
            uso: null,
          });

          lotesPorDiccionario++;
          filasPorDiccionario += batch.length;
        }

        /*
         * ═══ SEGUNDA PASADA, EN DOS FASES: SONDA, DECISIÓN, RESTO ═══
         *
         * Antes esto era una sola tanda concurrente con TODOS los lotes. El problema no era la
         * concurrencia —esa parte funciona— sino que no había ningún momento en el que el
         * código pudiera mirar lo que el modelo ya había contestado y sacar una conclusión. Con
         * todo lanzado a la vez, la llamada 205 no sabe que las 204 anteriores dijeron lo mismo.
         *
         * Medido sobre el archivo real (House Products, 2026-08-18): 216 llamadas, USD 15,82,
         * 14 minutos — y 205 de esas llamadas fueron `Ventas` devolviendo `transaction/revenue`
         * en las 18.034 filas, sin una excepción.
         *
         * Así que ahora hay un punto de decisión:
         *
         *   FASE 1 (sonda)     `SONDA_LOTES` lotes de cada hoja, repartidos a lo largo de
         *                      ella, van al modelo.
         *   DECISIÓN           ¿coincidieron entre sí? (`ConsensoDeHoja.decidir`)
         *   FASE 2 (resto)     los que quedan van al modelo, o se resuelven con el veredicto
         *                      de la hoja si hubo consenso.
         *
         * Las dos fases son concurrentes por dentro; lo único serializado es la decisión, que
         * no hace E/S. El costo de partirlo en dos es una barrera de sincronización por
         * documento: la fase 2 arranca cuando termina el último lote de la sonda, o sea que se
         * pierde el solapamiento entre esos dos grupos. Con hojas grandes eso son segundos
         * contra los minutos que ahorra; con hojas chicas la sonda ES todo el trabajo y no hay
         * nada que solapar.
         *
         * LO QUE NO CAMBIA, y sigue valiendo para las dos fases: que un lote falle tumba el
         * job, deliberadamente — el documento va a `failed`, pg-boss reintenta, y la
         * reanudación por lote (CU-868kkgypv) salta lo ya confirmado. Y `runWithConcurrency`
         * —en vez de un `Promise.all`— garantiza que antes de propagar un error se espera a que
         * TODO lo que está en vuelo confirme su transacción: cada una de esas tareas es una
         * llamada a Claude ya pagada, y cortarlas a media confirmación obligaría a pagarlas
         * otra vez en el reintento.
         */
        const sonda: Pendiente[] = [];
        const resto: Pendiente[] = [];
        {
          /*
           * Cuenta sobre los lotes PENDIENTES, no sobre todos los de la hoja. En una
           * reanudación (CU-868kkgypv) los ya confirmados no están en `pendientes`, así que la
           * sonda se rearma con tres lotes nuevos. Es a propósito: el consenso vive en memoria
           * y una ejecución que se reanuda no lo hereda — reconstruirlo cuesta tres llamadas, y
           * dar por bueno un consenso que este proceso nunca vio no cuesta nada hasta que
           * clasifica mal media hoja.
           */
          const porHoja = new Map<string, Pendiente[]>();
          for (const p of pendientes) {
            const lista = porHoja.get(p.sheetName);
            if (lista) lista.push(p);
            else porHoja.set(p.sheetName, [p]);
          }
          for (const lista of porHoja.values()) {
            // REPARTIDA a lo largo de la hoja, no los primeros: el cierre de tabla y los
            // subtotales viven al final, y una sonda que solo mira el arranque no los ve nunca.
            // Ver `elegirSonda`.
            const enSonda = new Set(elegirSonda(lista.length));
            lista.forEach((p, i) => (enSonda.has(i) ? sonda : resto).push(p));
          }
        }

        /*
         * ═══ UN DÉBITO POR CARGA, NO POR LOTE (reporte de Jose, 2026-08-24) ═══
         *
         * Va acá y no dentro de `procesarLote` por dos motivos que se refuerzan: es el único
         * punto donde se sabe que la carga SÍ va a procesarse —la planificación ya decidió qué
         * hojas quedan vivas— y es código de una sola línea de ejecución, así que la
         * comprobación de idempotencia no compite con los diez lotes concurrentes.
         *
         * `unidades = 1`: la unidad de cobro es la CARGA. La regla sigue siendo `variable`
         * para no cambiar el catálogo, pero su multiplicador ya no es la cantidad de lotes —
         * que era el número que hacía a un archivo grande costar setenta veces uno chico sin
         * que nadie lo hubiera decidido.
         *
         * Sin regla activa no se debita ni se bloquea, igual que antes.
         */
        if (creditRule) {
          await withCompanyScope(companyId, async (db) => {
            if (await cargaYaDebitada(db, documentId)) return;
            await debitCredits(db, {
              companyId,
              actionKind: 'excel',
              credits: estimateRequiredCredits(creditRule, 1),
              creditRuleId: creditRule.id,
              refId: documentId,
            });
          });
        }

        const { errors: erroresSonda } = await runWithConcurrency(
          sonda,
          procesarLote,
          intakeConfig.batchConcurrency,
        );
        if (erroresSonda.length > 0) throw erroresSonda[0];

        /*
         * LA DECISIÓN. Solo se pregunta por las hojas que TIENEN lotes restantes: en una hoja
         * que cupo entera en la sonda no hay nada que ahorrar, y registrar su motivo llenaría
         * el log de líneas sobre hojas de catorce filas.
         */
        const restantesPorHoja = new Map<string, number>();
        for (const p of resto) {
          restantesPorHoja.set(p.sheetName, (restantesPorHoja.get(p.sheetName) ?? 0) + 1);
        }

        const veredictoPorHoja = new Map<string, VeredictoDominante>();
        for (const [sheetName, restantes] of restantesPorHoja) {
          const columnas = mapasPorHoja.get(sheetName);
          const consenso = consensos.get(sheetName);
          if (!columnas || !consenso) continue;

          const decision = consenso.decidir(columnas);
          if (decision.homogenea) {
            veredictoPorHoja.set(sheetName, decision.veredicto);
            const v = decision.veredicto;
            console.info(
              `[excel-ingest] company=${companyId} hoja "${sheetName}": consenso tras ` +
                `${consenso.lotesObservados} lote(s) — ${v.targetEntity}/${v.type ?? '-'}/` +
                `${v.category ?? '-'} (confianza ${v.confidence.toFixed(2)}). Sus ${restantes} ` +
                `lote(s) restantes se resuelven sin llamar al modelo.`,
            );
          } else {
            /*
             * "Van al modelo" habría sido mentira desde que existe el diccionario: este
             * mensaje se imprime ANTES de preguntarle, y en la corrida que motivó el
             * mecanismo 7 de esos 8 lotes se resolvieron sin llamar a nadie. Se dice lo que
             * este punto sabe —que el consenso no aplica— y el conteo real de llamadas sale
             * en la línea de cierre, que es la única que puede afirmarlo.
             */
            console.info(
              `[excel-ingest] company=${companyId} hoja "${sheetName}": sin consenso ` +
                `(${decision.motivo}). Sus ${restantes} lote(s) restantes se resuelven fila ` +
                `por fila (diccionario si lo cubre, modelo si no).`,
            );
          }
        }

        /*
         * FASE 2. Los lotes de una hoja con consenso NO llaman a Claude; el resto sí, con la
         * misma ventana de concurrencia de siempre.
         *
         * Los dos grupos se corren por separado y no en una sola lista mixta porque comparten
         * el límite de concurrencia y no deberían: la ventana de 10 está dimensionada contra
         * los límites de tasa de Anthropic (ver config/intake.ts), y un lote local no consume
         * nada de eso. Mezclarlos dejaría cupos de red ocupados por trabajo que solo usa CPU y
         * una transacción corta.
         */
        const alModelo: Pendiente[] = [];
        const locales: {
          pendiente: Pendiente;
          veredicto: VeredictoDominante;
          columnas: ColumnMap;
        }[] = [];
        const porDiccionario: {
          pendiente: Pendiente;
          porIndice: Map<number, VeredictoCrudo>;
          columnas: ColumnMap;
        }[] = [];
        for (const p of resto) {
          const columnas = mapasPorHoja.get(p.sheetName);
          if (!columnas) {
            alModelo.push(p);
            continue;
          }

          /*
           * EL CONSENSO DE HOJA VA PRIMERO, y no es preferencia: es que sabe más.
           *
           * Cuando una hoja es homogénea, su veredicto se midió sobre las filas de ESTA carga,
           * en tres llamadas que coincidieron por encima del 98 %. El diccionario, en cambio,
           * responde por concepto y con reglas de cargas anteriores. Las dos son buenas, pero
           * ante la misma fila la evidencia recién medida gana.
           *
           * Y hay un motivo concreto además del orden de la evidencia: en una hoja homogénea
           * el consenso cubre el lote entero SIEMPRE, mientras que el diccionario exige que
           * las 88 filas estén conocidas. Preguntarle primero al diccionario sería gastar el
           * recorrido para terminar en el mismo lugar casi siempre.
           */
          const veredicto = veredictoPorHoja.get(p.sheetName);
          if (veredicto) {
            locales.push({ pendiente: p, veredicto, columnas });
            continue;
          }

          /*
           * Sin consenso de hoja: la única salida que queda antes de pagar es que el
           * diccionario conozca TODAS las filas de este lote. Si falta una, va al modelo.
           */
          const delDiccionario = resolverLoteConDiccionario(p.batch, columnas, diccionario);
          if (delDiccionario) {
            porDiccionario.push({ pendiente: p, porIndice: delDiccionario, columnas });
          } else {
            alModelo.push(p);
          }
        }

        const { errors: erroresResto } = await runWithConcurrency(
          alModelo,
          procesarLote,
          intakeConfig.batchConcurrency,
        );
        const { errors: erroresLocales } = await runWithConcurrency(
          locales,
          procesarLoteLocal,
          intakeConfig.batchConcurrency,
        );
        const { errors: erroresDiccionario } = await runWithConcurrency(
          porDiccionario,
          procesarLotePorDiccionario,
          intakeConfig.batchConcurrency,
        );
        const errores = [...erroresResto, ...erroresLocales, ...erroresDiccionario];
        if (errores.length > 0) throw errores[0];

        if (lotesCortocircuitados > 0 || lotesPorDiccionario > 0) {
          const llamadas = sonda.length + alModelo.length;
          const evitadas = lotesCortocircuitados + lotesPorDiccionario;
          /*
           * Los dos ahorros se nombran POR SEPARADO aunque el total sea uno. Cuando un cliente
           * pregunte por qué su carga costó lo que costó, "consenso de hoja" y "diccionario"
           * llevan a mirar cosas distintas: lo primero, si sus hojas son homogéneas; lo
           * segundo, cuánto de su libro ya se aprendió. Un número agregado no distingue una
           * carga que aprovechó todo de una que no aprovechó nada de lo aprendido.
           */
          const partes = [
            lotesCortocircuitados > 0
              ? `${lotesCortocircuitados} lote(s) y ${filasCortocircuitadas} fila(s) por ` +
                `consenso de hoja`
              : null,
            lotesPorDiccionario > 0
              ? `${lotesPorDiccionario} lote(s) y ${filasPorDiccionario} fila(s) por ` +
                `diccionario de la empresa`
              : null,
          ].filter((x): x is string => x !== null);
          console.info(
            `[excel-ingest] company=${companyId} document=${documentId} resuelto sin modelo: ` +
              `${partes.join(' · ')}. Llamadas a Claude: ${llamadas} en vez de ` +
              `${llamadas + evitadas}.` +
              (filasAptasFallidas > 0
                ? ` ${filasAptasFallidas} fila(s) no parecían movimientos y fueron a revisión.`
                : ''),
          );
        }
        /*
         * ═══ GUARDAR EL DICCIONARIO (Keneth–Semi, 2026-08-20) ═══
         *
         * Va acá, después de que todos los lotes confirmaron, y no dentro de cada lote: si la
         * carga se cancela o falla a mitad, no quedan reglas a medias — y `company_category_rules`
         * es append-only, así que no se podrían limpiar después.
         *
         * Un fallo al guardar NO tumba la carga. La contabilidad del cliente ya está
         * promovida y correcta; lo que se pierde es el ahorro de la PRÓXIMA carga, que se
         * vuelve a aprender sola la próxima vez. Tumbar una carga buena por eso sería cambiar
         * un problema de costo por uno de datos.
         */
        if (aprendidas.length > 0) {
          try {
            const escritas = await withCompanyScope(companyId, (db) =>
              guardarReglasAprendidas(db, companyId, aprendidas),
            );
            if (escritas > 0) {
              console.info(
                `[excel-ingest] company=${companyId} document=${documentId} diccionario: ` +
                  `${escritas} concepto(s) nuevo(s) aprendidos de ${aprendidas.length} ` +
                  `clasificación(es). La próxima carga no vuelve a preguntarlos.`,
              );
            }
          } catch (e) {
            console.error(
              `[excel-ingest] company=${companyId} document=${documentId} no se pudo guardar el ` +
                `diccionario de categorías (la carga NO se afecta):`,
              e,
            );
          }
        }
        if (nombresDelDiccionario > 0) {
          console.info(
            `[excel-ingest] company=${companyId} document=${documentId} diccionario: ` +
              `${nombresDelDiccionario} categoría(s) tomaron el nombre que esta empresa ya usaba ` +
              `en cargas anteriores, en vez de uno nuevo para el mismo concepto.`,
          );
        }
        if (canonizador.nombresUnificados > 0) {
          console.info(
            `[excel-ingest] company=${companyId} document=${documentId} ` +
              `${canonizador.nombresUnificados} categoría(s) renombradas al nombre que ya usaba ` +
              `su hoja (lotes distintos bautizaron el mismo concepto de formas distintas).`,
          );
        }

        if (confianzas.filasElevadas > 0) {
          console.info(
            `[excel-ingest] company=${companyId} document=${documentId} ` +
              `${confianzas.filasElevadas} fila(s) recuperaron la confianza que el modelo ya le ` +
              `había dado a su mismo veredicto en esa hoja (el lote traía una nota uniforme).`,
          );
        }

        /*
         * ═══ APRENDER Y ADVERTIR (CU-868krmrcj) ═══
         *
         * Con todos los lotes confirmados, `mapasPorHoja` tiene el mapa definitivo de cada
         * hoja. Dos cosas con él:
         *
         *   1. Comparar contra el perfil que la empresa ya tenía. Si algo que ANTES se leía
         *      ahora no está, o está en otra columna, se le avisa al cliente. Ganar una
         *      columna nueva no avisa: es una mejora, y un aviso que salta siempre deja de
         *      leerse (ver `ameritaAdvertencia`).
         *   2. Guardar el mapa como versión nueva del perfil, para que la próxima carga
         *      arranque sabiendo esto.
         *
         * VA DESPUÉS DE LOS LOTES Y ANTES DE PROMOVER. Después, porque hasta que el último
         * lote no confirma, el mapa de la hoja todavía puede afinarse (`fusionarMapaDeColumnas`
         * completa los nulos de un lote con lo que vio otro). Antes de promover, porque el
         * aviso tiene que poder viajar con el estado final del documento.
         *
         * NO ROMPE LA CARGA SI FALLA. Guardar el perfil es aprendizaje, no contabilidad: los
         * datos del cliente ya están en staging y su promoción no depende de esto. Un fallo
         * acá —incluida la colisión de versión entre dos cargas simultáneas, que el UNIQUE de
         * la migración arbitra— solo significa que la próxima carga vuelve a inferir el mapa.
         */
        for (const [sheetName, mapaFinal] of mapasPorHoja) {
          const headerRow = encabezadosPorHoja.get(sheetName);
          if (!headerRow) continue;

          /*
           * El resumen se arma ACÁ y no dentro de `procesarLote` porque este es el único
           * punto donde el mapa de la hoja es FINAL: `fusionarMapaDeColumnas` lo completa
           * lote a lote, así que el mapa del primer lote todavía puede tener nulos que el
           * tercero rellena. Enseñarle al cliente el mapa del primer lote sería enseñarle una
           * versión provisional de lo que entendimos.
           */
          /*
           * Cuánto dinero traía la hoja, con el mapa ya definitivo. Es la cifra que el dueño
           * reconoce o desmiente de un vistazo — ver `lib/reconciliation.ts` para el caso que
           * la motivó y para por qué esto MIDE y no bloquea la promoción.
           */
          const medicion = medirFilas(
            filasCrudasPorHoja.get(sheetName) ?? [],
            mapaFinal,
            baseCurrency,
          );

          hojasLeidas.push({
            estado: 'movimientos',
            nombre: sheetName,
            filas: filasPorHoja.get(sheetName) ?? 0,
            columnas: columnasEnPalabras(mapaFinal, headerRow),
            // Vacío se omite: una hoja sin columna de monto no tiene un total que enseñar, y
            // un `[]` en el resumen se leería como "leí Q 0".
            ...(medicion.montos.length > 0 ? { montos: medicion.montos } : {}),
            ...(medicion.costos.length > 0 ? { costos: medicion.costos } : {}),
            ...(notaDeDespivotado.has(sheetName)
              ? { nota: notaDeDespivotado.get(sheetName)! }
              : {}),
          });

          /*
           * Se acumula para el CUADRE de abajo: lo leído del archivo, por moneda, sumando
           * monto y costo (el costo produce su propia fila en el ledger). Ver `lib/cuadre.ts`.
           */
          for (const m of medicion.montos) {
            const previo = leidoDelArchivo.get(m.moneda) ?? {
              moneda: m.moneda,
              monto: 0,
              costo: 0,
            };
            previo.monto += m.total;
            leidoDelArchivo.set(m.moneda, previo);
          }
          for (const c of medicion.costos) {
            const previo = leidoDelArchivo.get(c.moneda) ?? {
              moneda: c.moneda,
              monto: 0,
              costo: 0,
            };
            previo.costo += c.total;
            leidoDelArchivo.set(c.moneda, previo);
          }
          filasMedidas += medicion.filasEnviadas;

          // Y aparte, sin mezclar con las otras hojas.
          const deEstaHoja = new Map<string, LeidoDelArchivo>();
          for (const m of medicion.montos) {
            const p = deEstaHoja.get(m.moneda) ?? { moneda: m.moneda, monto: 0, costo: 0 };
            p.monto += m.total;
            deEstaHoja.set(m.moneda, p);
          }
          for (const c of medicion.costos) {
            const p = deEstaHoja.get(c.moneda) ?? { moneda: c.moneda, monto: 0, costo: 0 };
            p.costo += c.total;
            deEstaHoja.set(c.moneda, p);
          }
          leidoPorHoja.set(sheetName, {
            montos: [...deEstaHoja.values()],
            filas: medicion.filasEnviadas,
          });

          if (medicion.montos.length > 0) {
            console.info(
              `[excel-ingest] company=${companyId} hoja "${sheetName}": ` +
                medicion.montos.map((m) => `${m.moneda} ${m.total.toFixed(2)}`).join(' · ') +
                ` en ${medicion.filasEnviadas} filas leídas del archivo`,
            );
          }

          const perfil = perfilesPorHoja.get(sheetName);
          if (perfil) {
            const diferencias = diferenciasDeMapa(perfil.columnMap, mapaFinal);
            if (ameritaAdvertencia(diferencias)) {
              const campos = diferencias.filter((d) => d.antes !== null).map((d) => d.campo);
              avisos.push(INTAKE_MESSAGES[locale].estructuraCambiada(sheetName, campos));
              console.warn(
                `[excel-ingest] company=${companyId} hoja "${sheetName}": la estructura cambió ` +
                  `respecto al perfil v${perfil.version} — ${campos.join(', ')} ya no están donde estaban`,
              );
            }
          }

          await withCompanyScope(companyId, (db) =>
            guardarPerfil(db, {
              companyId,
              headerRow,
              sheetName,
              columnMap: mapaFinal,
              source: 'inferido',
            }),
          ).catch((err) => {
            console.error(
              `[excel-ingest] company=${companyId} hoja "${sheetName}": no se pudo guardar el ` +
                `perfil de columnas (la carga sigue, se re-inferirá la próxima vez):`,
              err,
            );
          });
        }

        /*
         * El número con el que se verifica EN PRODUCCIÓN que la deduplicación funciona.
         *
         * Sin esto, el ahorro es invisible: el panel de costo mostraría un gasto menor y no
         * habría forma de saber si fue por la deduplicación o porque el cliente subió menos
         * filas. Con la proporción en el log, la primera carga semanal de cualquier cliente
         * confirma o desmiente el arreglo de un vistazo.
         *
         * `console.info` y no una métrica: es diagnóstico de bajo volumen (una línea por
         * documento) y el proyecto todavía no tiene un sink de métricas.
         */
        if (totalRowsSkippedPreFiltro > 0 || totalRowsSkippedDedup > 0) {
          const total = totalRowsProcessed + totalRowsSkippedPreFiltro + totalRowsSkippedDedup;
          const pct = (n: number) => Math.round((n / total) * 100);
          console.info(
            `[excel-ingest] company=${companyId} document=${documentId} de ${total} filas: ` +
              `${totalRowsSkippedPreFiltro} (${pct(totalRowsSkippedPreFiltro)}%) descartadas por ` +
              `el pre-filtro de hojas, ${totalRowsSkippedDedup} (${pct(totalRowsSkippedDedup)}%) ` +
              `ya ingeridas antes. Al modelo fueron ${totalRowsProcessed}.`,
          );
        }

        /*
         * ═══ CANCELADO: NO SE PROMUEVE Y NO SE PISA EL ESTADO ═══
         *
         * Sin esta salida, el bloque de abajo terminaría poniendo `promoted` o `review` sobre
         * un documento que el cliente acababa de cancelar — el botón se vería como si no
         * hubiera hecho nada, que es peor que no tenerlo.
         *
         * Tampoco se promueve lo ya clasificado: si el cliente paró la carga, meter media
         * contabilidad a sus dashboards es exactamente lo que no pidió. Las filas quedan en
         * staging y sus huellas registradas, así que volver a subir el archivo cobra solo lo
         * que falte.
         */
        if (await cancelado()) {
          console.info(
            `[excel-ingest] company=${companyId} document=${documentId} cancelado por el ` +
              `cliente: ${totalRowsProcessed} filas alcanzaron a procesarse y NO se promueven`,
          );
          return;
        }

        /*
         * ═══ EL INVENTARIO SE APLICA ACÁ (CU-868krkfrh) ═══
         *
         * Después del chequeo de cancelación de arriba, que es lo que importa: si el cliente
         * paró la carga, no se le toca el stock — igual que no se le promueven los
         * movimientos. Las dos mitades del archivo entran juntas o no entra ninguna.
         *
         * En su propia transacción y NO en la de la promoción: son dos módulos distintos y un
         * fallo del inventario no puede tumbar la contabilidad, que es lo que el cliente vino
         * a subir. Al revés tampoco — el inventario ya aplicado es correcto aunque la
         * promoción después quede en revisión, porque lo que dice es "hoy tengo esto", no
         * "esto pasó".
         */
        for (const hoja of hojasDeInventario) {
          const resultado = await withCompanyScope(companyId, (db) =>
            importarInventario(db, {
              companyId,
              documentId,
              userId: uploadedBy,
              headerRow: hoja.headerRow,
              rows: hoja.filas,
              baseCurrency: baseCurrency as Currency,
              mapa: hoja.mapa,
            }),
          ).catch((err) => {
            console.error(
              `[excel-ingest] company=${companyId} hoja "${hoja.sheetName}": falló la importación de inventario:`,
              err,
            );
            return null;
          });

          if (resultado) {
            hojasLeidas.push({
              estado: 'inventario',
              nombre: hoja.sheetName,
              creados: resultado.creados,
              ajustados: resultado.ajustados,
              sinCambio: resultado.sinCambio,
              omitidas: resultado.omitidas,
            });
            console.info(
              `[excel-ingest] company=${companyId} hoja "${hoja.sheetName}" importada a inventario: ` +
                `${resultado.creados} altas, ${resultado.ajustados} ajustes, ` +
                `${resultado.sinCambio} sin cambio, ${resultado.omitidas} omitidas`,
            );
          }
        }

        /*
         * ═══ EL RESUMEN DE LECTURA SE GUARDA PASE LO QUE PASE (CU-868krmrcj) ═══
         *
         * En su propia transacción y ANTES de la promoción, a propósito: el resumen tiene que
         * existir incluso cuando el documento termina en `review`, en `unsupported` o sin una
         * sola fila. Es justo en esos casos cuando el cliente más necesita saber QUÉ leímos —
         * un archivo que no produjo nada y no explica por qué es exactamente el problema que
         * este resumen viene a eliminar.
         *
         * Best-effort: si falla, la carga sigue. El resumen es para explicar, no para
         * contabilizar; perderlo es una molestia, no un dato perdido del cliente.
         */
        await withCompanyScope(companyId, (db) =>
          db
            .update(documents)
            .set({
              readSummary: construirResumen(hojasLeidas, {
                movimientos: totalRowsProcessed,
                descartadas: totalRowsSkippedPreFiltro,
                yaIngeridas: totalRowsSkippedDedup,
              }),
            })
            .where(eq(documents.id, documentId)),
        ).catch((err) => {
          console.error(
            `[excel-ingest] company=${companyId} document=${documentId} no se pudo guardar el ` +
              `resumen de lectura (la carga sigue):`,
            err,
          );
        });

        const promotedThisRun = await withCompanyScope(companyId, async (db) => {
          /*
           * ═══════════════════════════════════════════════════════════════════════════════════
           * EL PORTÓN: NADA SE PROMUEVE SOLO (migración 0042, 2026-09-01)
           * ═══════════════════════════════════════════════════════════════════════════════════
           *
           * Este es uno de los DOS caminos a la promoción; el otro es
           * `encolarPromocionDeLoResuelto`, que lo afirma por su cuenta. Ver la nota larga allá
           * para el porqué y para el riesgo que esto reintroduce a propósito.
           *
           * Se pregunta ANTES de llamar a `promoteDocument` y no dentro: esa función es el
           * mecanismo de promover y la usa también el camino que abre el portón, así que
           * meterle la condición de producto la volvería imposible de llamar desde ahí.
           */
          const [gate] = await db
            .select({ confirmedAt: documents.confirmedAt })
            .from(documents)
            .where(eq(documents.id, documentId));
          /*
           * ⚠️ Una carga que NO produjo una sola fila no tiene nada que confirmar. Pedirle al
           * cliente que apruebe un archivo vacío —el caso típico es resubir el mismo libro,
           * cuyas filas ya estaban ingeridas— es interrumpirlo para nada, y encima lo dejaría
           * mirando una pantalla sin una cifra. Esas siguen su camino normal (`no_rows` →
           * `unsupported`, o el aviso de "ya tenías estos datos").
           */
          const [conFilas] = await db
            .select({ n: rawSql<string>`count(*)` })
            .from(stagingRows)
            .where(
              and(eq(stagingRows.companyId, companyId), eq(stagingRows.documentId, documentId)),
            );
          const hayAlgoQueConfirmar = Number(conFilas?.n ?? 0) > 0;

          if (gate && gate.confirmedAt === null && hayAlgoQueConfirmar) {
            const [p] = await db
              .select({ n: rawSql<string>`count(*)` })
              .from(stagingRows)
              .where(
                and(
                  eq(stagingRows.companyId, companyId),
                  eq(stagingRows.documentId, documentId),
                  eq(stagingRows.reviewStatus, 'pending'),
                ),
              );
            await db
              .update(documents)
              .set({
                status: 'awaiting_confirmation',
                rowCount: totalRowsProcessed,
                flaggedCount: Number(p?.n ?? 0),
              })
              .where(eq(documents.id, documentId));
            esperandoConfirmacion = true;
            return false;
          }

          const promotion = await promoteDocument(db, companyId, documentId);

          // Otra ejecución del MISMO documento ya promovió (dos workers a la vez: ver la
          // nota de la reserva en lib/promotion.ts). Se sale sin tocar nada. Sin este
          // caso, el `if (!promotion.promoted)` de abajo caería en la rama de revisión y
          // pisaría con `review` un documento que la otra ejecución dejó bien promovido —
          // el cliente vería "en revisión" un archivo cuyos datos ya están en su
          // dashboard. Tampoco se re-encola la evaluación de alertas: la disparó el
          // ganador.
          if (!promotion.promoted && promotion.reason === 'already_promoted') return false;

          // NADA que promover: el archivo no produjo una sola fila. Antes esto caía en
          // la misma rama que las filas marcadas y terminaba en `review` — el cliente
          // veía "En revisión" indefinidamente por un documento sin nada que revisar, y
          // del lado de Macha aparecía una revisión interna vacía. Es un desenlace
          // distinto y ahora tiene estado propio: `unsupported`, terminal, con la única
          // acción que sirve (llenar la plantilla). No es `failed` porque reintentar el
          // mismo archivo daría exactamente lo mismo.
          if (!promotion.promoted && promotion.reason === 'no_rows') {
            /*
             * ═══ "CERO FILAS" YA NO SIGNIFICA UNA SOLA COSA ═══
             *
             * Esta rama es anterior a la deduplicación. Entonces, que un documento no
             * produjera filas solo podía querer decir que el archivo era ilegible, y
             * `unsupported` con "descarga la plantilla" era la respuesta correcta.
             *
             * Desde que existe la huella por fila hay un SEGUNDO camino a cero filas, y es el
             * OPUESTO: el cliente resubió su contabilidad completa y ya la teníamos toda. Eso
             * es el caso de éxito que la deduplicación viene a producir — cuesta USD 0 — y
             * hasta acá se le respondía "no pudimos leer movimientos financieros en este
             * archivo, descarga la plantilla y llénala".
             *
             * Encontrado corriendo el flujo completo sobre un archivo real (2026-08-12): la
             * segunda subida del mismo .xlsx terminó en `unsupported`. Ningún test unitario
             * podía verlo — hace falta la primera subida para que la segunda deduplique.
             *
             * El desempate es exacto: si TODO lo que no llegó al modelo fue por dedup y el
             * pre-filtro no descartó nada financiero, el archivo se entendió perfectamente.
             */
            if (totalRowsSkippedDedup > 0 && totalRowsProcessed === 0) {
              await db
                .update(documents)
                .set({
                  status: 'promoted',
                  rowCount: 0,
                  flaggedCount: 0,
                  errorReason: INTAKE_MESSAGES[locale].nothingNew(totalRowsSkippedDedup),
                })
                .where(eq(documents.id, documentId));
              return false;
            }

            const reason = summarizeUnusableReasons(unusableReasons);
            await db
              .update(documents)
              .set({
                status: 'unsupported',
                rowCount: 0,
                flaggedCount: 0,
                errorReason: INTAKE_MESSAGES[locale].unsupportedContent(reason),
              })
              .where(eq(documents.id, documentId));
            return false;
          }

          if (!promotion.promoted) {
            // Filas pendientes/marcadas: queda para revisión interna (US-17). El reintento
            // de la promoción lo dispara la propia revisión — el `PATCH` de
            // `/admin/staging-rows` encola `document.promote` en cuanto el documento se
            // queda sin filas `pending` (ver `queue/workers/document-promote.ts`). Durante
            // meses este comentario prometió ese reintento y no existía: el documento se
            // quedaba en `review` para siempre y NINGÚN upload llegó nunca a producción.
            await db
              .update(documents)
              // CU-868kn5hqu: `flagged_count` se persiste acá. Antes solo lo escribía la
              // promoción exitosa (a 0), así que un documento en revisión lo dejaba en
              // NULL y ni el cliente ni el panel podían decir cuántas filas faltaban.
              .set({
                status: 'review',
                rowCount: totalRowsProcessed,
                flaggedCount: promotion.pendingCount,
              })
              .where(eq(documents.id, documentId));
            return false;
          }
          /*
           * CU-868krmrcj: el aviso de estructura viaja con el documento ya promovido.
           *
           * Se escribe en `errorReason` porque ese campo es, de hecho, el canal de mensaje al
           * cliente y no solo de errores — `nothingNew` ya lo usa exactamente así sobre un
           * documento `promoted`. Meter una columna nueva para esto sería una migración a
           * cambio de nada.
           *
           * Va DESPUÉS de `promoteDocument`, que es quien fija `status` y `row_count`: al
           * revés, la promoción pisaría el mensaje.
           *
           * Solo en el camino limpio. Si el documento quedó en revisión o sin filas, ese
           * estado es lo que el cliente necesita leer primero, y encima ahí `errorReason` ya
           * lleva su propio mensaje.
           */
          if (avisos.length > 0) {
            await db
              .update(documents)
              .set({ errorReason: avisos.join(' ') })
              .where(eq(documents.id, documentId));
          }

          // CU-868kfvab1: cache-aside — recomputa solo los rollups que la empresa ya
          // había visto antes; los nunca vistos se llenan perezosamente en /metrics.
          await refreshExistingRollups(db, companyId);
          return true;
        });

        /*
         * ═══════════════════════════════════════════════════════════════════════════════════
         * EL CUADRE: ¿LO QUE ATERRIZÓ SE PARECE A LO QUE EL ARCHIVO DECÍA? (2026-08-30)
         * ═══════════════════════════════════════════════════════════════════════════════════
         *
         * `medirFilas` ya escribía cuánto dinero traía cada hoja, y **nadie lo comparaba nunca
         * contra el resultado**: el lazo estaba abierto. Este bloque lo cierra.
         *
         * Importa más que cualquier test y por un motivo que costó siete reportes entender:
         * los tests cubren archivos que YA VIMOS. Esto es lo único que funciona sobre el que
         * va a subir el próximo cliente.
         *
         * ⚠️ **Va DESPUÉS de `promoteDocument`**, y ese orden es todo el punto: antes de
         * promover el ledger está VACÍO, así que el cuadre leería cero y reportaría
         * `nada_aterrizo` en TODAS las cargas. El primer intento lo puso antes y produjo
         * exactamente eso — un falso positivo sistemático, o sea un detector que grita siempre
         * y al que por lo tanto nadie le haría caso. Lo atrapó el test de integración contra
         * Postgres real; ningún test unitario podía verlo, porque el orden de dos bloques del
         * worker no se ve desde afuera.
         *
         * **No bloquea nada, y es decisión.** Un falso positivo que frene la promoción deja al
         * cliente sin su contabilidad por un chequeo que se equivocó — peor que el problema que
         * viene a resolver. Lo que cambia desde ya es que un descuadre queda ESCRITO: cuando un
         * cliente reporte "esto no cuadra", la respuesta ya está registrada en vez de haber que
         * reconstruirla a mano durante horas, que es exactamente lo que pasó las siete veces.
         *
         * Un fallo acá NO tumba la carga: la contabilidad ya está promovida y correcta o no
         * según el pipeline; lo que se pierde es el diagnóstico.
         */
        await withCompanyScope(companyId, async (db) => {
          if (leidoDelArchivo.size === 0) return;
          const [t, i, b] = await Promise.all([
            db
              .select({
                moneda: transactions.originalCurrency,
                monto: rawSql<string>`coalesce(sum(${transactions.originalAmount}), 0)`,
                filas: rawSql<string>`count(*)`,
              })
              .from(transactions)
              .where(
                and(
                  eq(transactions.companyId, companyId),
                  eq(transactions.documentId, documentId),
                  isNull(transactions.deletedAt),
                ),
              )
              .groupBy(transactions.originalCurrency),
            db
              .select({
                moneda: invoices.originalCurrency,
                monto: rawSql<string>`coalesce(sum(${invoices.originalAmount}), 0)`,
                filas: rawSql<string>`count(*)`,
              })
              .from(invoices)
              .where(
                and(
                  eq(invoices.companyId, companyId),
                  eq(invoices.documentId, documentId),
                  isNull(invoices.deletedAt),
                ),
              )
              .groupBy(invoices.originalCurrency),
            db
              .select({
                moneda: bills.originalCurrency,
                monto: rawSql<string>`coalesce(sum(${bills.originalAmount}), 0)`,
                filas: rawSql<string>`count(*)`,
              })
              .from(bills)
              .where(
                and(
                  eq(bills.companyId, companyId),
                  eq(bills.documentId, documentId),
                  isNull(bills.deletedAt),
                ),
              )
              .groupBy(bills.originalCurrency),
          ]);

          const porMoneda = new Map<string, number>();
          let filasEnElLedger = 0;
          for (const fila of [...t, ...i, ...b]) {
            porMoneda.set(fila.moneda, (porMoneda.get(fila.moneda) ?? 0) + Number(fila.monto));
            filasEnElLedger += Number(fila.filas);
          }

          /*
           * La EXPANSIÓN se calcula, no se adivina: el pipeline sabe cuántas filas de ledger
           * produjo por cada fila del archivo porque él mismo las creó. Es lo que convierte la
           * cota superior del cuadre de una constante imposible de elegir en un cálculo. Ver
           * el bloque de `MARGEN` en `lib/cuadre.ts`.
           */
          const expansion = filasMedidas > 0 ? filasEnElLedger / filasMedidas : 1;

          /*
           * Lo que quedó ESPERANDO REVISIÓN, que no es lo mismo que perdido. Un renglón de
           * TOTAL o una fila sin fecha legible se guarda en staging con su monto y espera a que
           * alguien la resuelva; ese dinero está identificado y con dueño.
           *
           * Sin esto el detector reportaba `falta` sobre cargas sanas —medido: una hoja con un
           * subtotal de Q 999.999 daba "falta el 89 %"— y un detector que grita sobre lo normal
           * es un detector que nadie mira.
           */
          const pendientes = await db
            .select({
              moneda: rawSql<string>`coalesce(${stagingRows.payload}->>'originalCurrency', 'GTQ')`,
              monto: rawSql<string>`coalesce(sum((${stagingRows.payload}->>'originalAmount')::numeric), 0)`,
            })
            .from(stagingRows)
            .where(
              and(
                eq(stagingRows.companyId, companyId),
                eq(stagingRows.documentId, documentId),
                eq(stagingRows.reviewStatus, 'pending'),
              ),
            )
            .groupBy(rawSql`coalesce(${stagingRows.payload}->>'originalCurrency', 'GTQ')`);

          /*
           * Lo que va a publicarse en cuanto el dueño confirme, por moneda. Solo se consulta
           * cuando hace falta: con la carga ya promovida, lo comparable es el ledger.
           */
          const aPublicarPorMoneda = new Map<string, number>();
          let filasAPublicar = 0;
          if (esperandoConfirmacion) {
            const filas = await db
              .select({
                moneda: rawSql<string>`coalesce(${stagingRows.payload}->>'originalCurrency', 'GTQ')`,
                monto: rawSql<string>`coalesce(sum((${stagingRows.payload}->>'originalAmount')::numeric), 0)`,
                filas: rawSql<string>`count(*)`,
              })
              .from(stagingRows)
              .where(
                and(
                  eq(stagingRows.companyId, companyId),
                  eq(stagingRows.documentId, documentId),
                  rawSql`${stagingRows.reviewStatus} <> 'rejected'`,
                  rawSql`${stagingRows.reviewStatus} <> 'pending'`,
                ),
              )
              .groupBy(rawSql`coalesce(${stagingRows.payload}->>'originalCurrency', 'GTQ')`);
            for (const f of filas) {
              aPublicarPorMoneda.set(f.moneda, Number(f.monto));
              /*
               * ⚠️ Y la EXPANSIÓN también sale de acá. Es lo que convierte la cota del cuadre
               * de una constante imposible de elegir en un cálculo, y con el ledger vacío daba
               * 0,00× — o sea que una carga de facturas, que legítimamente expande 2×, se
               * reportaba como "sobra: la misma plata contada dos veces". El numerador tiene
               * que salir de la misma fuente que el monto o la banda no le corresponde a nada.
               */
              filasAPublicar += Number(f.filas);
            }
          }

          /*
           * ⚠️ CON EL PORTÓN, LO COMPARABLE ES LO QUE VA A PUBLICARSE (migración 0042).
           *
           * El ledger está vacío a propósito: la carga espera la confirmación del dueño.
           * Comparar contra él daría `nada_aterrizo` en TODA carga nueva, y un detector que
           * grita siempre es uno que nadie mira — la misma lección que este módulo aprendió
           * con la hoja de cobros.
           *
           * Así que en ese momento la pregunta correcta no es "¿aterrizó?" sino "¿lo que
           * estamos a punto de publicar se parece a lo que el archivo traía?" — que además es
           * exactamente lo que el cliente tiene delante en la pantalla de confirmación. La
           * cifra sale de `staging_rows`, igual que la del cuadre POR HOJA, así que las dos
           * miran lo mismo. El paso staging→ledger lo verifica la propia `promoteDocument`,
           * que es atómica y devuelve qué insertó.
           */
          const porMonedaComparable = esperandoConfirmacion
            ? [...aPublicarPorMoneda.entries()].map(([moneda, monto]) => ({ moneda, monto }))
            : [...porMoneda.entries()].map(([moneda, monto]) => ({ moneda, monto }));

          const cuadres = evaluarCuadre(
            [...leidoDelArchivo.values()].map((l) => ({
              ...l,
              // Ver `declaradoNoDato`: un renglón de TOTAL se leyó pero nunca iba al ledger.
              monto: Math.max(0, l.monto - (declaradoNoDato.get(l.moneda) ?? 0)),
            })),
            porMonedaComparable,
            esperandoConfirmacion
              ? filasMedidas > 0
                ? filasAPublicar / filasMedidas
                : 1
              : expansion,
            pendientes.map((p) => ({ moneda: p.moneda, monto: Number(p.monto) })),
          );

          for (const c of cuadres) {
            const linea = `[cuadre] company=${companyId} document=${documentId} ${c.veredicto}: ${c.detalle}`;
            if (c.veredicto === 'cuadra' || c.veredicto === 'sin_datos') console.info(linea);
            else console.warn(linea);
          }
          /*
           * ═══════════════════════════════════════════════════════════════════════════════════
           * Y AHORA POR HOJA, QUE ES LO QUE EL TOTAL NO PUEDE VER
           * ═══════════════════════════════════════════════════════════════════════════════════
           *
           * El cuadre de arriba suma el documento entero y por eso se deja engañar: un libro
           * donde una hoja aterriza el DOBLE y otra aterriza CERO cuadra perfecto, porque los
           * dos errores se cancelan. Esa es la forma exacta de los fallos que llevamos meses
           * persiguiendo (KapePrueba: dos hojas de detalle perdidas y una cartera de clientes
           * inventando ingresos; CarsGT: cobros devengando de nuevo mientras el stock entraba
           * como costo).
           *
           * Se compara contra `staging_rows` y no contra el ledger porque el ledger no sabe de
           * qué hoja vino cada fila —`transactions` guarda `document_id`, no `sheet_name`— y
           * porque staging conserva el monto en la moneda ORIGINAL, así que la comparación no
           * arrastra el ruido de la conversión.
           */
          const porHojaEnStaging = await db
            .select({
              hoja: stagingRows.sheetName,
              moneda: rawSql<string>`coalesce(${stagingRows.payload}->>'originalCurrency', 'GTQ')`,
              promovido: rawSql<string>`coalesce(sum((${stagingRows.payload}->>'originalAmount')::numeric) filter (where ${stagingRows.promotedAt} is not null), 0)`,
              /*
               * Lo que VA a publicarse en cuanto el dueño confirme: ni rechazado ni pendiente.
               * Con el portón puesto nada está promovido todavía, así que sin esto el cuadre
               * por hoja reporta `nada_aterrizo` sobre TODAS las hojas de TODA carga nueva —
               * y un detector que grita siempre es uno que nadie mira. En ese momento la
               * pregunta correcta no es "¿aterrizó?" sino "¿lo que estamos a punto de publicar
               * se parece a lo que el archivo traía?", que es exactamente lo que el cliente
               * está mirando en la pantalla de confirmación.
               */
              porPublicar: rawSql<string>`coalesce(sum((${stagingRows.payload}->>'originalAmount')::numeric) filter (where ${stagingRows.reviewStatus} <> 'rejected' and ${stagingRows.reviewStatus} <> 'pending'), 0)`,
              pendiente: rawSql<string>`coalesce(sum((${stagingRows.payload}->>'originalAmount')::numeric) filter (where ${stagingRows.reviewStatus} = 'pending'), 0)`,
              filas: rawSql<string>`count(*)`,
            })
            .from(stagingRows)
            .where(
              and(
                eq(stagingRows.companyId, companyId),
                eq(stagingRows.documentId, documentId),
                isNotNull(stagingRows.sheetName),
              ),
            )
            .groupBy(
              stagingRows.sheetName,
              rawSql`coalesce(${stagingRows.payload}->>'originalCurrency', 'GTQ')`,
            );

          const agrupado = new Map<
            string,
            { aterrizado: AterrizadoEnElLedger[]; revision: AterrizadoEnElLedger[]; filas: number }
          >();
          for (const f of porHojaEnStaging) {
            const clave = f.hoja!;
            const e = agrupado.get(clave) ?? { aterrizado: [], revision: [], filas: 0 };
            e.aterrizado.push({
              moneda: f.moneda,
              // Ver `porPublicar`: mientras el portón retiene la carga, lo comparable es lo que
              // va a publicarse, no lo que ya se publicó (que es cero a propósito).
              monto: Number(esperandoConfirmacion ? f.porPublicar : f.promovido),
            });
            e.revision.push({ moneda: f.moneda, monto: Number(f.pendiente) });
            e.filas += Number(f.filas);
            agrupado.set(clave, e);
          }

          const porHojaCuadre = evaluarCuadrePorHoja(
            [...leidoPorHoja.entries()].map(([hoja, medido]) => {
              const enStaging = agrupado.get(hoja);
              return {
                hoja,
                leido: medido.montos,
                aterrizado: enStaging?.aterrizado ?? [],
                // La expansión de ESTA hoja, no la del documento: una hoja de facturas
                // expande 2× y la de gastos 1×, y usar el promedio del libro daría una banda
                // demasiado ancha para una y demasiado angosta para la otra.
                expansion: medido.filas > 0 && enStaging ? enStaging.filas / medido.filas : 1,
                enRevision: enStaging?.revision ?? [],
                suprimida: hojasSuprimidas.has(hoja),
              };
            }),
          );

          const descuadradas = hojasDescuadradas(porHojaCuadre);
          for (const d of descuadradas) {
            console.warn(
              `[cuadre] company=${companyId} document=${documentId} hoja "${d.hoja}" ${d.detalle}`,
            );
          }

          /*
           * ⚠️ EL VEREDICTO QUE MANDA ES EL DE POR HOJA, cuando lo hay.
           *
           * El cuadre del DOCUMENTO usa una expansión ESCALAR —filas de ledger sobre filas
           * medidas, en todo el libro— y esa cifra no le sirve a ninguna hoja en particular:
           * una de facturación expande 2× (la factura y su ingreso devengado) y una de gastos
           * 1×, así que el promedio deja la banda demasiado ancha para una y demasiado angosta
           * para la otra. Medido el 2026-09-01 en un libro con las tres cifras EXACTAS contra
           * su verdad de campo: el total dijo `sobra` en USD (1,19× contra una expansión
           * calculada de 0,79×) mientras las cinco hojas cuadraban una por una.
           *
           * Es exactamente el motivo por el que existe el cuadre por hoja, aplicado al otro
           * lado: el total del documento se deja engañar. Así que el total queda como RESPALDO
           * para lo que la vista por hoja no puede cubrir —filas sin `sheet_name`, o sea cargas
           * anteriores a la migración 0039— y deja de levantar su propia alarma cuando la vista
           * fina existe y no encontró nada. Un detector que grita sobre lo correcto enseña a
           * ignorarlo, que es la misma lección que el veredicto `no_se_registra`.
           */
          const hayVistaPorHoja = porHojaCuadre.length > 0;
          const hayAlgo = hayVistaPorHoja
            ? descuadradas.length > 0
            : hayDescuadre(cuadres) || descuadradas.length > 0;
          if (hayAlgo) {
            console.warn(
              `[cuadre] company=${companyId} document=${documentId} DESCUADRE: lo que aterrizó ` +
                `no se parece a lo que el archivo traía. Es la señal más temprana de una hoja ` +
                `perdida o contada dos veces.`,
            );
          }

          /*
           * ═══ Y SE GUARDA, QUE ES LA MITAD QUE FALTABA ═══
           *
           * Este bloque existía y su resultado moría en `console.warn`. El encabezado de
           * `lib/cuadre.ts` decía que "un descuadre queda ESCRITO en el resumen de la carga" y
           * no era cierto: `documents` no tenía dónde ponerlo. En Railway los logs no agregan,
           * no alertan y rotan — comprobado el 2026-08-31 buscando el veredicto de dos cargas
           * reportadas por el cliente: ya no existía.
           *
           * Es exactamente el error que `lib/read-summary.ts` documenta haber corregido para
           * los datos de lectura ("hoy va a console.info y rota con los logs de Railway"). La
           * lección se había aprendido en un módulo y no se había aplicado en el que más la
           * necesitaba.
           *
           * Va en su propia escritura y es best-effort: perder el diagnóstico es una molestia,
           * tumbar una carga ya promovida por no poder guardarlo sería un daño real.
           */
          await db
            .update(documents)
            .set({
              reconciliation: {
                verificadoEl: new Date().toISOString(),
                cuadra: !hayAlgo,
                documento: cuadres,
                hojas: porHojaCuadre,
              },
            })
            .where(eq(documents.id, documentId));
        }).catch((err) => {
          console.error(
            `[cuadre] company=${companyId} document=${documentId} no se pudo evaluar (la carga ` +
              `sigue, la contabilidad no se toca):`,
            err,
          );
        });

        if (promotedThisRun) {
          // CU-868kfvad3: evaluación de alertas tras cada Excel exitoso, desacoplada
          // vía la cola interna (no una llamada directa) — mismo patrón que el resto
          // de este worker.
          await enqueue(QUEUES.alertEvaluate, { companyId, documentId });
        }

        /*
         * ═══════════════════════════════════════════════════════════════════════════════════
         * EL AVISO AL CLIENTE: "TU ARCHIVO NECESITA TU ATENCIÓN" (CU-868kyur58)
         * ═══════════════════════════════════════════════════════════════════════════════════
         *
         * ⚠️ VA ACÁ Y NO "EN EL PUNTO DONDE SE ESCRIBE `status: 'review'`", QUE ES LO QUE PEDÍA
         * EL TICKET — y la diferencia no es de estilo: escrito ahí, el aviso **se pierde el caso
         * más común**.
         *
         * La promoción es PARCIAL desde la migración 0020 (decisión de Keneth, 2026-08-07). Una
         * carga con filas retenidas termina en `promoted` con `flagged_count > 0`, que es el
         * estado NORMAL; solo llega a `review` la que no pudo promover NADA. O sea que el punto
         * que nombra el ticket es la excepción, no la regla, y un cliente con 6 conceptos
         * pendientes sobre 1.200 filas limpias nunca habría recibido correo.
         *
         * Puesto después de la promoción, cubre los dos desenlaces con una sola llamada. Y no
         * hace falta condicionarlo acá: `avisarConceptosPendientes` ya decide sola —mira el
         * estado, las filas marcadas, los conceptos contestables y lo ya avisado— y esa decisión
         * tiene que vivir en UN lugar, porque la comparte con el conteo que el cliente ve en
         * pantalla.
         *
         * Envuelto, como el resto de lo que corre después de promover: la contabilidad ya está
         * bien y un fallo del correo no puede tumbar la carga.
         */
        await withCompanyScope(companyId, async (db) => {
          const r = await avisarConceptosPendientes(db, companyId, documentId);
          if (r.enviado) {
            console.info(
              `[aviso-revision] company=${companyId} document=${documentId} correo enviado a ` +
                `${r.destinatarios} destinatario(s): ${r.conceptos} concepto(s) sobre ` +
                `${r.documentos.length} carga(s).`,
            );
          }
        }).catch((err) => {
          console.error(
            `[aviso-revision] company=${companyId} document=${documentId} no se pudo avisar al ` +
              `cliente (la carga sigue, su contabilidad no se toca):`,
            err,
          );
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await withCompanyScope(companyId, (db) =>
          db
            .update(documents)
            .set({ status: 'failed', errorReason: message })
            .where(eq(documents.id, documentId)),
        ).catch(() => {
          // best-effort status update; never mask the original error below
        });
        throw err; // re-thrown so pg-boss applies the excel.ingest retry policy
      }
    },
  );
}
