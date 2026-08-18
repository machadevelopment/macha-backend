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
  | 'vacia';

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
): ResumenDeLectura {
  return { hojas: ordenarHojas(hojas), totales };
}
