/**
 * Arma el payload de una fila a partir del MAPA DE COLUMNAS y la fila cruda.
 *
 * ═══ POR QUÉ EXISTE ESTE ARCHIVO ═══
 *
 * Hasta ahora el modelo devolvía la fila entera reconstruida: fecha, monto, moneda,
 * descripción, producto, cantidad. Nueve campos por fila, con structured outputs obligando a
 * que vinieran los nueve incluso en null, y la descripción copiada palabra por palabra.
 *
 * El costo medido el 2026-08-12 dijo que el 95,7 % del recibo eran tokens de SALIDA — unos
 * 71 por fila. Y como el modelo genera la salida token por token, esos mismos tokens son los
 * 40-50 minutos de espera. El desperdicio y la lentitud eran la misma cosa.
 *
 * Lo perverso: SIETE de esos nueve campos ya los tenía el backend. Se los había mandado él
 * en la fila cruda. Estaba pagando USD 10 por millón de tokens para que se los devolvieran
 * copiados.
 *
 * ═══ QUÉ SIGUE HACIENDO EL MODELO ═══
 *
 * Lo que de verdad requiere criterio y no se puede resolver con código:
 *
 *   · UNA VEZ POR HOJA — el mapa de columnas: qué índice es la fecha, cuál el monto, cuál
 *     la descripción. Antes lo resolvía implícitamente en cada fila; ahora lo dice una vez.
 *   · POR FILA — a qué entidad va (transaction/invoice/bill), el tipo contable, la
 *     categoría, y su confianza. Cuatro campos cortos en vez de nueve con valores.
 *
 * El código hace el resto: leer la celda que el mapa señala. Eso no es criterio, es indexar.
 *
 * ═══ LO QUE NO CAMBIA ═══
 *
 * La forma del payload que sale de acá es EXACTAMENTE la de antes, campo por campo. Todo lo
 * de aguas abajo —`staging-rules.ts`, la promoción, la pantalla de revisión— sigue viendo lo
 * mismo. El cambio es de dónde salen los valores, no cuáles son.
 */

/**
 * Índices de columna que el modelo identifica una vez por hoja. `null` = la hoja no trae esa
 * columna, que es información legítima y distinta de "no la encontré".
 */
export type ColumnMap = {
  date: number | null;
  amount: number | null;
  currency: number | null;
  description: number | null;
  counterparty: number | null;
  product: number | null;
  quantity: number | null;
  productCategory: number | null;
  dueDate: number | null;
  /*
   * ═══ EL COSTO DE LA PROPIA FILA DE VENTA ═══
   *
   * Muchos libros de PYME traen el ingreso Y el costo en la MISMA fila:
   *
   *   Fecha | Producto | Unidades | Ingreso Total (Q) | Costo Total (Q) | Utilidad (Q)
   *   46174 | Café Am. | 6        | 108               | 27              | 81
   *
   * Hasta acá esa columna no la leía nadie: una fila producía UNA transacción, la de
   * ingreso, y el costo se perdía. Consecuencia observada en producción (2026-08-14):
   * `cogs = 0` para todos los productos y margen 100 % en toda la pantalla de Ventas por
   * producto — con el dato ahí, en la celda de al lado.
   *
   * Dos índices y no uno porque las hojas reales traen las dos formas y confundirlas
   * multiplica o divide el costo por las unidades:
   *   · `costTotal` — el costo de ESTA línea completa ("Costo Total (Q)" = 27).
   *   · `costUnit`  — el costo de UNA unidad ("CostoUnitario" = 135,52 con Cantidad 2).
   */
  costTotal: number | null;
  costUnit: number | null;
};

/** Lo que el modelo devuelve POR FILA. Cuatro campos cortos, sin valores copiados. */
export type RowVerdict = {
  /** Índice de la fila dentro del lote, tal como se le presentó. */
  i: number;
  targetEntity: 'transaction' | 'invoice' | 'bill';
  /** Solo para `transaction`; en invoice/bill se ignora. */
  type: 'revenue' | 'cogs' | 'opex' | 'other' | null;
  /** Texto libre, igual que antes: si nada aplica, el modelo inventa un nombre corto. */
  category: string | null;
  confidence: number;
};

const cell = (row: unknown[], idx: number | null): unknown =>
  idx === null || idx < 0 || idx >= row.length ? null : row[idx];

/**
 * Un texto o `null`. Nunca `""`: la cadena vacía pasaría la validación de "hay categoría"
 * de `staging-rules.ts` sin serlo, y la fila entraría a producción sin categoría real en vez
 * de irse a revisión.
 */
function asText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  return s === '' ? null : s;
}

/**
 * Un número o `null`.
 *
 * Se aceptan las dos formas en que Excel entrega dinero: número nativo, o texto con
 * separadores de miles y símbolo ("Q 1,234.50"). Lo que NO se hace es adivinar: si tras
 * limpiar no queda un número, devuelve `null` y la fila se marca por `invalid_amount`. Eso
 * es correcto — la alternativa sería inventar un monto.
 */
function asNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;

  const limpio = value.replace(/[^0-9.,-]/g, '').trim();
  if (limpio === '') return null;

  /*
   * La coma puede ser separador de miles (1,234.50) o decimal (1234,50). Se decide por
   * cuál aparece de último: en "1.234,50" la coma va después del punto y es la decimal.
   * Es la heurística que acierta en los dos formatos sin preguntar la configuración
   * regional, que el archivo no trae.
   */
  const ultimaComa = limpio.lastIndexOf(',');
  const ultimoPunto = limpio.lastIndexOf('.');
  const normalizado =
    ultimaComa > ultimoPunto
      ? limpio.replace(/\./g, '').replace(',', '.')
      : limpio.replace(/,/g, '');

  const n = Number(normalizado);
  return Number.isFinite(n) ? n : null;
}

/**
 * Fecha a `YYYY-MM-DD`.
 *
 * Excel entrega las fechas como NÚMERO DE SERIE (45878 = 2025-08-09), no como texto — se ve
 * en los archivos reales del cliente. Convertirlo mal desplazaría todos los movimientos de
 * fecha en silencio, que es de los peores errores posibles en un producto contable.
 *
 * La época de Excel es el 1899-12-30 (no el 31, por el bug del año bisiesto de Lotus 1-2-3
 * que Excel conserva a propósito).
 */
export function asDate(value: unknown): string | null {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString().slice(0, 10);
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    /*
     * RANGO DE PLAUSIBILIDAD DE NEGOCIO, no el rango técnico de Excel.
     *
     * El rango técnico (1 = 1899-12-31 en adelante) es demasiado permisivo y deja pasar el
     * error que de verdad ocurre: un MONTO en la columna equivocada. El serial 491 es una
     * fecha válida —1901-05-05— así que un monto de 491.38 se convertiría en una fecha
     * perfectamente creíble y entraría a la contabilidad del cliente sin marcarse.
     *
     * Lo encontró un test con un monto real de los archivos de prueba.
     *
     * Se acota a lo que puede ser un movimiento de una PYME: 32874 = 1990-01-01 y
     * 73415 = 2101-01-01. Un monto típico (cientos o miles) queda fuera por abajo, que es
     * el caso que importa. Una fecha real de contabilidad nunca cae ahí.
     */
    if (value < 32_874 || value > 73_415) return null;
    const ms = Math.round(value) * 86_400_000;
    const epoca = Date.UTC(1899, 11, 30);
    return new Date(epoca + ms).toISOString().slice(0, 10);
  }

  const s = asText(value);
  if (!s) return null;
  const parsed = new Date(s);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10);
}

/**
 * Moneda de la fila.
 *
 * Si la hoja no trae columna de moneda —el caso normal en los archivos reales— se usa la
 * moneda BASE de la empresa. Eso no es una suposición arriesgada: es el mismo default que
 * el modelo aplicaba antes, solo que ahora está escrito donde se puede leer y probar.
 */
function asCurrency(value: unknown, baseCurrency: string): string {
  const s = asText(value);
  if (!s) return baseCurrency;
  const upper = s.toUpperCase();
  return upper === 'GTQ' || upper === 'USD' ? upper : baseCurrency;
}

/**
 * Construye el payload de una fila, con la MISMA forma que devolvía el modelo antes.
 *
 * `quantity` sigue distinguiendo `null` de `0`: null es "esta fila no habla de unidades" (un
 * alquiler, un total) y 0 son cero unidades. Sobre el primero no se puede promediar. Es la
 * misma regla que el prompt le exigía al modelo, ahora garantizada por código en vez de por
 * instrucción — que es estrictamente más fiable.
 */
/**
 * El costo de ESTA fila, si la hoja lo trae. `null` = no hay costo que registrar.
 *
 * Se prefiere el total de línea cuando existe: es un dato directo del archivo. El unitario
 * solo se usa multiplicado por las unidades, y **solo si la fila trae unidades** — sin ellas
 * no se puede saber el costo de la línea, y la respuesta correcta es no inventarlo. Esa es la
 * misma regla que el prompt ya exige para `quantity`: si la fila no dice cuántas, no sabemos
 * cuántas.
 */
export function costoDeLaFila(row: unknown[], columns: ColumnMap): number | null {
  const total = asNumber(cell(row, columns.costTotal));
  if (total !== null) return Math.abs(total);

  const unitario = asNumber(cell(row, columns.costUnit));
  const unidades = asNumber(cell(row, columns.quantity));
  if (unitario === null || unidades === null) return null;
  return Math.abs(unitario * unidades);
}

export function assemblePayload(params: {
  verdict: RowVerdict;
  row: unknown[];
  columns: ColumnMap;
  baseCurrency: string;
}): Record<string, unknown> {
  const { verdict, row, columns, baseCurrency } = params;

  /*
   * EL SIGNO SE DESCARTA, Y ES OBLIGATORIO — no una comodidad.
   *
   * Muchos exportes traen los gastos en negativo ("Planilla enero, -18.000"). La dirección
   * del movimiento no la lleva el signo: la lleva `type` (revenue vs. cogs/opex). Y aguas
   * abajo `staging-rules.ts` exige `isPositiveFiniteNumber` en las dos formas de payload,
   * así que un monto negativo NO se guarda con el signo — se marca `invalid_amount` y la
   * fila se va a revisión interna.
   *
   * Esto lo hacía el modelo sin que estuviera escrito en ningún lado (se ve en los ejemplos
   * few-shot: entra -18000, sale 18000). Al dejar de pedirle los valores había que traerlo
   * al código, o una hoja de gastos exportada en negativo se habría marcado ENTERA. No lo
   * atrapó ningún test: lo atrapó leer qué valida `staging-rules` antes de dar por bueno el
   * cambio.
   */
  const bruto = asNumber(cell(row, columns.amount));
  const amount = bruto === null ? null : Math.abs(bruto);
  const currency = asCurrency(cell(row, columns.currency), baseCurrency);

  if (verdict.targetEntity === 'transaction') {
    return {
      type: verdict.type ?? 'other',
      category: verdict.category,
      date: asDate(cell(row, columns.date)),
      description: asText(cell(row, columns.description)),
      originalAmount: amount,
      originalCurrency: currency,
      product: asText(cell(row, columns.product)),
      quantity: asNumber(cell(row, columns.quantity)),
      productCategory: asText(cell(row, columns.productCategory)),
    };
  }

  // invoice / bill comparten forma (AR/AP).
  return {
    counterparty: asText(cell(row, columns.counterparty)),
    issueDate: asDate(cell(row, columns.date)),
    dueDate: asDate(cell(row, columns.dueDate)),
    originalAmount: amount,
    originalCurrency: currency,
  };
}
