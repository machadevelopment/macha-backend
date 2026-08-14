import * as XLSX from 'xlsx';
import { and, eq } from 'drizzle-orm';
import { registerWorker, enqueue, QUEUES } from '@/queue';
import { withCompanyScope } from '@/lib/db-scope';
import { downloadObject } from '@/lib/s3';
import { documents, documentIngestBatches, companies, ingestedRows } from '@/db/schema';
import { intakeConfig } from '@/config/intake';
import { INTAKE_MESSAGES, summarizeUnusableReasons } from '@/lib/intake-messages';
import { classifySheetRows, fusionarMapaDeColumnas } from '@/lib/anthropic';
import type { ColumnMap } from '@/lib/row-assembly';
import { resolveIndustryTemplate } from '@/lib/industry-template';
import { planBatchSize } from '@/lib/sheet-batching';
import { fingerprintSheet, findSeenFingerprints } from '@/lib/row-fingerprint';
import { detectarFilaDeEncabezado } from '@/lib/sheet-header';
import { analizarFormaDeHoja } from '@/lib/sheet-shape';
import { canSkipSheet } from '@/lib/sheet-classifier';
import { insertStagingRows } from '@/lib/staging';
import { runWithConcurrency } from '@/lib/concurrency';
import { insertAiUsageEvent } from '@/lib/ai-usage';
import { promoteDocument } from '@/lib/promotion';
import { refreshExistingRollups } from '@/lib/rollups';
import { getActiveCreditRule, estimateRequiredCredits, debitCredits } from '@/lib/credits';

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

        const { templateVersion, s3Key, creditRule, locale, baseCurrency } = await withCompanyScope(
          companyId,
          async (db) => {
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
            };
          },
        );

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
        const mapasPorHoja = new Map<string, ColumnMap>();

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

          const rows: unknown[][] = XLSX.utils.sheet_to_json(sheet, {
            header: 1,
            blankrows: false,
          });
          if (rows.length === 0) continue;

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
          const headerRow = rows[filaEncabezado] ?? [];
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
          const forma = analizarFormaDeHoja(rows);
          if (forma.esReporte) {
            totalRowsSkippedPreFiltro += rows.length;
            unusableReasons.add(`la hoja "${sheetName}" ${forma.motivo}`);
            console.info(
              `[excel-ingest] company=${companyId} hoja "${sheetName}" descartada por forma ` +
                `(${forma.motivo}): ${rows.length} filas no van al modelo`,
            );
            continue;
          }

          // `rows[0]` ya ES el encabezado real: el corte de arriba quitó los títulos.
          if (canSkipSheet(rows[0] ?? [])) {
            totalRowsSkippedPreFiltro += rows.length;
            console.info(
              `[excel-ingest] company=${companyId} hoja "${sheetName}" descartada por encabezados (catálogo, no movimientos): ${rows.length} filas no van al modelo`,
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
          if (filtradas.length === 0) continue;

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
          }
        }

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
            headerRow,
            baseCurrency,
            /*
             * Lo que la hoja ya sabe, para que este lote arme sus valores con eso y no con
             * sus propios nulos. Sin esto, un lote que no distinguió la columna de monto
             * dejaba TODAS sus filas sin monto — se marcaban `invalid_amount` y se iban a
             * revisión manual, con el dato ahí al lado en la celda.
             */
            columnsCanonicas: mapasPorHoja.get(sheetName),
          });

          // Se recoge, no se actúa todavía: una hoja ilegible en un libro que por lo
          // demás trae datos buenos no debe tumbar la carga. Lo que decide el estado
          // terminal es si el documento COMPLETO no produjo ninguna fila (abajo).
          if (!result.sheetUsable && result.unusableReason) {
            unusableReasons.add(result.unusableReason);
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

            await insertAiUsageEvent(db, {
              companyId,
              kind: 'excel',
              refId: documentId,
              model: result.model,
              inputTokens: result.inputTokens,
              outputTokens: result.outputTokens,
              cacheReadTokens: result.cacheReadTokens,
              cacheCreationTokens: result.cacheCreationTokens,
              billableUnits: batch.length,
            });
            await insertStagingRows(db, companyId, documentId, result.rows);

            /*
             * Las huellas se registran en la MISMA transacción que el resto del lote. Si
             * se registraran antes de llamar a Claude, un fallo dejaría las filas marcadas
             * como vistas SIN haberse procesado: se perderían para siempre, porque la
             * próxima carga las filtraría. Registrarlas al confirmar significa que una
             * huella existe si y solo si su fila llegó a staging.
             *
             * `onConflictDoNothing` cubre dos ejecuciones solapadas del mismo job y el
             * caso de una fila que aparezca en dos hojas con el mismo contenido.
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
                .onConflictDoNothing();
            }

            // Débito por lote (CU-868kfvaa6): la regla `excel` es variable, 1
            // crédito/lote (scripts/seed.ts). Sin regla activa = sin cap, per v1
            // (no bloquea ni descuenta) — mismo comportamiento que antes de F0.
            //
            // Concurrente sin riesgo: `credit_transactions` es append-only y `debitCredits`
            // es un INSERT sin lectura de saldo previa, así que dos débitos en vuelo no se
            // pisan ni pueden leer un saldo obsoleto.
            if (creditRule) {
              await debitCredits(db, {
                companyId,
                actionKind: 'excel',
                credits: estimateRequiredCredits(creditRule, 1),
                creditRuleId: creditRule.id,
                refId: documentId,
              });
            }
          });

          totalRowsProcessed += batch.length;
        }

        /**
         * SEGUNDA PASADA: los lotes van a Claude en paralelo, de a
         * `intakeConfig.batchConcurrency`.
         *
         * Que un lote falle siga tumbando el job es deliberado: el documento va a `failed`,
         * pg-boss reintenta, y la reanudación por lote (CU-868kkgypv) salta lo ya confirmado.
         * Lo que `runWithConcurrency` garantiza —y por eso no se usa un `Promise.all`— es que
         * antes de lanzar se espera a que TODO lo que está en vuelo confirme su transacción:
         * cada una de esas tareas es una llamada a Claude ya pagada, y cortarlas a mitad de
         * camino obligaría a pagarlas otra vez en el reintento.
         */
        const { errors } = await runWithConcurrency(
          pendientes,
          procesarLote,
          intakeConfig.batchConcurrency,
        );
        if (errors.length > 0) throw errors[0];

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

        const promotedThisRun = await withCompanyScope(companyId, async (db) => {
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
          // CU-868kfvab1: cache-aside — recomputa solo los rollups que la empresa ya
          // había visto antes; los nunca vistos se llenan perezosamente en /metrics.
          await refreshExistingRollups(db, companyId);
          return true;
        });

        if (promotedThisRun) {
          // CU-868kfvad3: evaluación de alertas tras cada Excel exitoso, desacoplada
          // vía la cola interna (no una llamada directa) — mismo patrón que el resto
          // de este worker.
          await enqueue(QUEUES.alertEvaluate, { companyId, documentId });
        }
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
