import { CLAVES_DE_COLUMNA, type ColumnMap } from './row-assembly';

/**
 * Qué entendió el sistema del archivo del cliente.
 *
 * ═══ POR QUÉ EXISTE (CU-868krmrcj) ═══
 *
 * El ticket pedía RESTRINGIR las cargas: fijar la cuenta a una industria y rechazar lo que
 * no calce. Trabajándolo se ve que ataca el modo de fallo equivocado. Los cuatro modos, de
 * más dañino a menos:
 *
 *   1. LEER MAL EN SILENCIO — el dato entra desde la columna equivocada. Números plausibles,
 *      cero errores. En un producto de CFO es el que destruye la confianza.
 *   2. PERDER EN SILENCIO — el pre-filtro descarta ~50 % de las filas de cada archivo. La
 *      hoja de inventario se tiró durante MESES (211 filas por carga, tres empresas) y nadie
 *      se enteró hasta que un cliente preguntó por qué su inventario estaba vacío.
 *   3. Vacío inexplicable — "Q 0,00" sin decir por qué.
 *   4. Rechazo visible — el menos dañino de los cuatro: es honesto.
 *
 * Restringir ataca el 4 y CREA uno nuevo (rechazar archivos legítimos: el cliente que
 * cambió de exportador, que diversificó, que agregó una hoja). No toca el 1 ni el 2.
 *
 * Lo que sí los ataca es que el cliente PUEDA VER lo que entendimos. Un mapeo equivocado
 * deja de ser invisible en cuanto la pantalla dice "el monto lo leímos de la columna
 * «Precio Unitario»" y el dueño responde "esa no es, esa es lo que cobro por unidad".
 *
 * ═══ ESTO NO CUESTA UN SOLO TOKEN ═══
 *
 * Todo lo que hay acá el worker YA lo sabe: qué hojas procesó, cuáles descartó y por qué,
 * cuántas filas, y con qué mapa de columnas leyó cada una. Hoy va a `console.info` y rota
 * con los logs de Railway. Lo único que faltaba era guardarlo y enseñarlo.
 *
 * ═══ SE GUARDA EL MAPA COMO NOMBRES, NO COMO ÍNDICES ═══
 *
 * `{"amount": 4}` no le dice nada a nadie. `{"monto": "Ingreso Total (Q)"}` es lo que hace
 * que el dueño pueda confirmar o desmentir. El índice se resuelve contra los encabezados
 * REALES del archivo en el momento de armar el resumen, porque después ya no están.
 */

/** Por qué una hoja no produjo movimientos. Cada motivo tiene su explicación al cliente. */
export type MotivoDeDescarte =
  /** Catálogo (clientes, proveedores, productos, tiendas): describe entidades, no hechos. */
  | 'catalogo'
  /** Reporte con los datos a lo ancho (meses como columnas), no una tabla de movimientos. */
  | 'reporte'
  /** Duplica el dinero de otra hoja a distinta granularidad (LineasOC vs OrdenesCompra). */
  | 'duplica_otra_hoja'
  /** Todas sus filas ya se habían ingerido en una carga anterior. */
  | 'ya_ingerida'
  /** Menos de dos filas: no hay tabla que leer. */
  | 'vacia'
  /**
   * No tiene una columna de fecha legible con dinero en otra columna, así que ninguna de sus
   * filas puede ser un movimiento (`noPuedeProducirMovimientos`).
   *
   * ⚠️ NACIÓ PORQUE ESTE DESCARTE SE REPORTABA COMO `catalogo`, Y ESO ERA MENTIRLE AL CLIENTE.
   * El texto de `catalogo` dice "describe tus clientes, productos o proveedores", que es una
   * afirmación sobre el CONTENIDO de su hoja — y acá lo único que sabemos es que no pudimos
   * leerle una fecha. Cuando esa explicación no le calza a lo que él tiene delante, deja de
   * creerle al resumen entero, que es la única herramienta que tenemos para que nos desmienta.
   * Es además el filtro que dejó el dashboard de KapePrueba en cero.
   */
  | 'sin_fecha_ni_monto';

export type HojaLeida =
  | {
      estado: 'movimientos';
      nombre: string;
      /** Filas que llegaron al modelo y produjeron filas de staging. */
      filas: number;
      /**
       * Qué columna se leyó para cada campo, EN PALABRAS. `null` = la hoja no traía ese
       * campo, que es información legítima y distinta de "no lo encontré".
       */
      columnas: Record<string, string | null>;
      /**
       * TODOS los encabezados de la hoja, en su orden real.
       *
       * `columnas` dice de dónde SALIÓ cada dato; esto es lo que permite corregirlo. El fallo
       * que el portón todavía no podía atajar es el que `sheet-header` describe como el peor
       * de su clase —"no falla nada visible: los datos salen de las columnas equivocadas"—, y
       * enseñarle al dueño que el monto salió de «Precio Unitario» sin darle dónde elegir
       * «Total» lo deja mirando el error sin salida.
       *
       * El índice es la posición en este arreglo, y es el mismo que consume
       * `sheet_overrides.columnas` (migración 0043). Opcional: los resúmenes anteriores al
       * 2026-09-01 no lo traen, y ausente significa "no se puede corregir desde la pantalla",
       * nunca "la hoja no tiene columnas".
       */
      encabezados?: string[];
      /**
       * CUÁNTO DINERO TRAÍA LA HOJA, separado por moneda.
       *
       * Es la cifra que el dueño puede desmentir de un vistazo, y por eso es la más útil del
       * resumen: reconoce sus propias ventas. Un cliente subió 19 meses de contabilidad, el
       * dashboard abrió en "este mes" y el reporte fue "esta data no tiene nada que ver con
       * el Excel" — las cifras estaban bien al quetzal, pero no había dónde comprobarlo.
       *
       * Opcional porque los resúmenes guardados antes de 2026-08-25 no lo traen. Ausente no
       * significa cero: significa que esa carga es anterior a la medición. Ver
       * `lib/reconciliation.ts`.
       */
      montos?: { moneda: string; total: number; filas: number }[];
      /**
       * El COSTO que la hoja declaraba en su propia columna, cuando la trae.
       *
       * Va aparte del monto y nunca sumado: en un libro de PYME el costo vive al lado del
       * precio en la misma fila, y mezclarlos daría un número que no es ni la venta ni el
       * costo. Es además lo que explica que el ledger tenga más filas que el archivo — esa
       * columna produce una segunda transacción.
       */
      costos?: { moneda: string; total: number; filas: number }[];
      /**
       * La hoja no venía como listado: era un REPORTE por mes que se convirtió en movimientos.
       *
       * Se dice explícitamente porque el cliente cuenta filas. Su matriz de gastos tiene 16
       * renglones y el resumen le va a decir 128 movimientos; sin esta nota parece que el
       * sistema inventó filas, cuando lo que hizo fue abrir cada concepto en sus doce meses.
       */
      nota?: string;
    }
  | {
      estado: 'inventario';
      nombre: string;
      creados: number;
      ajustados: number;
      sinCambio: number;
      omitidas: number;
    }
  | {
      estado: 'descartada';
      nombre: string;
      motivo: MotivoDeDescarte;
      filas: number;
      /** Solo para `duplica_otra_hoja`: con cuál se solapa. */
      duplicaDe?: string;
      /**
       * CUÁNTO DINERO SE LLEVÓ ESTE DESCARTE, estimado (`lib/sheet-money.ts`).
       *
       * Es el cambio que convierte una decisión invisible en una que el dueño puede
       * desmentir. "Descarté 220 filas" no le dice nada a nadie; "descarté Q 2.707.318
       * porque LineasOC repite el dinero de OrdenesCompra" se contesta de un vistazo, y es
       * exactamente la frase que habría evitado los seis reportes de ingesta que llegaron.
       *
       * ⚠️ Es una ESTIMACIÓN sobre encabezados y magnitudes, no el mapa del modelo: esta hoja
       * nunca llegó a tenerlo. Sirve para explicar y para ranquear el riesgo de la decisión,
       * jamás para contabilizar. Opcional porque las cargas anteriores a esto no lo traen, y
       * ausente NO significa cero.
       */
      montos?: { moneda: string; total: number; filas: number }[];
    };

export interface ResumenDeLectura {
  hojas: HojaLeida[];
  totales: {
    /** Filas que entraron a la contabilidad del cliente. */
    movimientos: number;
    /** Filas que no llegaron al modelo por el pre-filtro de hojas. */
    descartadas: number;
    /** Filas ya vistas en cargas anteriores: no se reprocesaron ni se cobraron. */
    yaIngeridas: number;
  };
}

/**
 * Nombres de campo en el idioma del DUEÑO, no del esquema.
 *
 * `counterparty` y `productCategory` no significan nada para quien lleva la contabilidad de
 * una cafetería. El resumen existe para que ÉL pueda desmentirlo, así que se escribe en sus
 * palabras o no sirve de nada.
 */
const NOMBRE_DE_CAMPO: Record<keyof ColumnMap, string> = {
  date: 'fecha',
  amount: 'monto',
  currency: 'moneda',
  description: 'descripción',
  counterparty: 'cliente o proveedor',
  product: 'producto',
  quantity: 'cantidad',
  productCategory: 'categoría del producto',
  store: 'tienda',
  dueDate: 'fecha de vencimiento',
  costTotal: 'costo de la línea',
  costUnit: 'costo por unidad',
};

/**
 * Traduce el mapa de índices al mapa de nombres, resolviendo cada índice contra los
 * encabezados reales de la hoja.
 *
 * Los campos que la hoja NO trae se OMITEN en vez de guardarse en `null`. Un resumen con
 * once líneas de las que ocho dicen "no traía" es ruido; el dueño necesita ver de un vistazo
 * las cuatro que sí importan. Lo que falta se nota por ausencia, y para eso está el conteo.
 *
 * Un índice fuera de rango se omite también: significa que el modelo señaló una columna que
 * no existe, y mostrarla como "columna 13" sería inventar precisión.
 */
export function columnasEnPalabras(
  columnMap: ColumnMap,
  headerRow: readonly unknown[],
): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const clave of CLAVES_DE_COLUMNA) {
    const idx = columnMap[clave];
    if (idx === null || idx === undefined || idx < 0 || idx >= headerRow.length) continue;

    const encabezado = String(headerRow[idx] ?? '').trim();
    /*
     * Si la celda del encabezado está vacía se guarda el número de columna como último
     * recurso. Es peor que un nombre, pero mucho mejor que omitir el campo: "el monto salió
     * de la columna 5" al menos se puede ir a mirar en el archivo.
     */
    out[NOMBRE_DE_CAMPO[clave]] = encabezado || `columna ${idx + 1}`;
  }
  return out;
}

/**
 * Ordena las hojas para que lo importante quede arriba.
 *
 * Primero lo que produjo datos (movimientos, inventario), después lo descartado. Dentro de
 * cada grupo, por número de filas descendente: si el pre-filtro tiró 221 filas de una hoja,
 * eso es lo primero que el cliente tiene que poder cuestionar — y con orden alfabético
 * quedaría enterrado entre hojas de seis filas.
 */
export function ordenarHojas(hojas: HojaLeida[]): HojaLeida[] {
  const peso = (h: HojaLeida) => (h.estado === 'descartada' ? 1 : 0);
  const filas = (h: HojaLeida) => {
    if (h.estado === 'movimientos') return h.filas;
    if (h.estado === 'descartada') return h.filas;
    return h.creados + h.ajustados + h.sinCambio;
  };
  return [...hojas].sort((a, b) => peso(a) - peso(b) || filas(b) - filas(a));
}

/** Arma el resumen final. Separado del worker para poder probarlo sin Postgres ni S3. */
export function construirResumen(
  hojas: HojaLeida[],
  totales: ResumenDeLectura['totales'],
  previo?: ResumenDeLectura | null,
): ResumenDeLectura {
  return {
    hojas: ordenarHojas(fusionarHojas(hojas, previo)),
    totales: sumarTotales(totales, hojas, previo),
  };
}

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * ⚠️ UNA CORRIDA DE REPROCESO NO PUEDE BORRAR LAS HOJAS QUE NO TOCÓ (2026-09-01)
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *
 * El worker es reanudable por lote a propósito (`document_ingest_batches` tiene índice único),
 * así que una corrida que vuelve sobre un documento **salta las hojas que ya se procesaron** y
 * nunca las agrega a `hojasLeidas`. Guardar ese resumen tal cual las BORRA de la pantalla.
 *
 * Medido en producción con `EL-INFIERNO-v43-2027.xlsx`, apenas se desplegó el rescate de hoja:
 * el portón pasó de **18 hojas a 9**, y las que desaparecieron son las principales —`Ventas`,
 * `Gastos_Operativos`, `OrdenesCompra`, `Facturacion`—. Sus 97 filas de staging seguían ahí, o
 * sea que **la contabilidad no se pierde**: lo que se rompe es la única pantalla con la que el
 * dueño decide si publicarla. Le mostrábamos un archivo mutilado y le pedíamos que lo aprobara.
 *
 * El defecto es ANTERIOR al rescate —cualquier reintento tras un fallo hacía lo mismo— pero
 * hasta hoy solo pasaba después de un error. El rescate lo vuelve el camino normal, así que
 * deja de ser un caso de borde.
 *
 * Se fusiona POR NOMBRE DE HOJA y gana la corrida NUEVA: si esta corrida volvió a leer
 * `Resumen_Ventas`, su veredicto nuevo es el que vale — es justamente lo que el dueño pidió al
 * rescatarla. Lo que esta corrida no tocó conserva lo que decía antes, que es lo único que se
 * sabe de esa hoja.
 */
function fusionarHojas(nuevas: HojaLeida[], previo?: ResumenDeLectura | null): HojaLeida[] {
  if (!previo?.hojas?.length) return nuevas;
  const porNombre = new Map(previo.hojas.map((h) => [h.nombre, h]));
  for (const h of nuevas) porNombre.set(h.nombre, h);
  return [...porNombre.values()];
}

/**
 * Los totales de una corrida de reproceso cuentan solo sus propias filas.
 *
 * Sumar los del resumen previo contaría dos veces las hojas que esta corrida VOLVIÓ a leer, así
 * que se suma únicamente lo que aporta cada corrida sobre hojas distintas: se descuenta del
 * previo lo que las hojas re-leídas ya habían aportado. Con `previo` ausente —la corrida
 * normal— devuelve los totales tal cual y no cambia nada.
 */
function sumarTotales(
  totales: ResumenDeLectura['totales'],
  nuevas: HojaLeida[],
  previo?: ResumenDeLectura | null,
): ResumenDeLectura['totales'] {
  if (!previo?.hojas?.length) return totales;
  const releidas = new Set(nuevas.map((h) => h.nombre));
  const filasDe = (h: HojaLeida) => ('filas' in h ? (h.filas ?? 0) : 0);
  const previas = previo.hojas.filter((h) => !releidas.has(h.nombre));
  return {
    movimientos:
      totales.movimientos +
      previas.filter((h) => h.estado === 'movimientos').reduce((s, h) => s + filasDe(h), 0),
    descartadas:
      totales.descartadas +
      previas.filter((h) => h.estado === 'descartada').reduce((s, h) => s + filasDe(h), 0),
    yaIngeridas: totales.yaIngeridas,
  };
}
