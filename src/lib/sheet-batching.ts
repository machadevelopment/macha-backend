import { intakeConfig } from '@/config/intake';

/**
 * CU-868kmwdqu — cuántas filas caben en UNA llamada a Claude.
 *
 * El tamaño de lote se decidía solo por número de filas: hojas de menos de
 * `largeSheetRowThreshold` (5.000) iban enteras en una llamada. Con el primer Excel
 * real de producción eso reventó: la hoja `Ventas` (521 filas × 16 columnas) generaba
 * más salida de la que cabe en `max_tokens`, el modelo cortaba a media respuesta y el
 * JSON llegaba partido. El error resultante decía "not valid JSON despite structured
 * output", que manda a investigar el lugar equivocado — structured output garantiza la
 * FORMA de la respuesta, no que quepa en el presupuesto de salida.
 *
 * LO QUE MANDA ES EL ANCHO, NO SOLO EL LARGO. Cada fila clasificada se devuelve como un
 * objeto con su payload mapeado, así que una fila de 16 columnas cuesta varias veces más
 * salida que una de 3. Contar solo filas ignora justo la variable que hace explotar el
 * presupuesto — por eso 521 filas cabían en la cuenta de filas (521 < 5.000) y no cabían
 * en la de tokens.
 *
 * Medido contra las llamadas reales de producción del 2026-08-05 (mismo libro, 7 hojas
 * completadas): la salida por fila clasificada rondó los 100-130 tokens en hojas de
 * 16-17 columnas, y bastante menos en las angostas. De ahí los dos coeficientes de
 * abajo, deliberadamente conservadores: subestimar cuesta un documento fallido entero,
 * sobreestimar cuesta una llamada extra.
 */

/**
 * RECALIBRADO con producción (2026-08-05, segunda corrida del mismo libro). La primera
 * versión de estos coeficientes asumía que la salida crece con el ancho de la hoja, y
 * los números reales dicen que **no**:
 *
 *   | hoja          | cols | filas | tokens salida | por fila |
 *   |---------------|------|-------|---------------|----------|
 *   | Tiendas       |  10  |    6  |         3.695 |    616   |
 *   | Productos     |  17  |   43  |        12.638 |    294   |
 *   | OrdenesCompra |   7  |   61  |        13.028 |    214   |
 *   | Clientes      |  13  |  101  |        20.145 |    200   |
 *   | Inventario    |   9  |  211  |        19.758 |     94   |
 *   | LineasOC      |   6  |  224  |        19.758 |     88   |
 *   | Proveedores   |   9  |    7  |           256 |     37   |
 *
 * Una hoja de 7 columnas costó 214 tokens por fila y una de 9 costó 94: el ancho de
 * ENTRADA no manda. Lo que manda es cuántas filas decide clasificar el modelo y qué tan
 * largo sale cada payload, que es una propiedad del contenido, no de la forma. Con la
 * calibración vieja el planificador mandó 305 filas de `Ventas` en una llamada y la
 * respuesta volvió a cortarse — el mismo documento perdido, ahora con un error honesto.
 *
 * De ahí el cambio de forma: **domina un costo fijo por fila, calibrado sobre el peor
 * caso creíble** (~294, descartando `Tiendas` porque con 6 filas el overhead fijo de la
 * respuesta se reparte entre muy pocas y no representa a un lote grande). El término por
 * celda se conserva pequeño, como corrección de segundo orden, no como el factor
 * principal que era.
 *
 * Se asume el costo: hojas angostas se parten más de lo estrictamente necesario y eso
 * son llamadas de más a Anthropic. Es el lado barato del error — el otro lado es perder
 * el documento entero.
 */
const OUTPUT_TOKENS_PER_ROW_BASE = 300;

/** Corrección de segundo orden por ancho. Pequeña a propósito: ver la tabla de arriba. */
const OUTPUT_TOKENS_PER_CELL = 8;

/**
 * Cuántas columnas mira para estimar el ancho. Una hoja puede traer una fila
 * anómalamente ancha (un título desparramado, una fila de totales); se toma un
 * percentil alto en vez del máximo para que una sola fila rara no encoja todos los
 * lotes de la hoja, y en vez del promedio para que una hoja con muchas filas cortas al
 * inicio no subestime el ancho real.
 */
function representativeCellCount(rows: unknown[][]): number {
  if (rows.length === 0) return 0;
  const widths = rows.map((r) => r.length).sort((a, b) => a - b);
  const idx = Math.min(widths.length - 1, Math.floor(widths.length * 0.9));
  return widths[idx] ?? 0;
}

export function estimatedOutputTokensPerRow(rows: unknown[][]): number {
  return OUTPUT_TOKENS_PER_ROW_BASE + representativeCellCount(rows) * OUTPUT_TOKENS_PER_CELL;
}

/**
 * Filas por lote para una hoja. Nunca devuelve 0: una fila sola, por ancha que sea,
 * tiene que poder intentarse — si ni así cabe, quien falla es la llamada y el error lo
 * dice con nombre y apellido (ver `SheetOutputTruncatedError` en lib/anthropic.ts), en
 * vez de partirse en lotes vacíos para siempre.
 */
export function planBatchSize(rows: unknown[][]): number {
  if (rows.length === 0) return 0;

  const perRow = estimatedOutputTokensPerRow(rows);
  const byBudget = Math.floor(intakeConfig.outputTokenBudget / perRow);

  // El cap por filas se conserva como techo — sigue siendo la regla aprobada por Jose
  // en CU-868kfv972 — pero ahora es el MENOR de los dos el que manda.
  const byRowCap =
    rows.length > intakeConfig.largeSheetRowThreshold ? intakeConfig.batchSize : rows.length;

  return Math.max(1, Math.min(byRowCap, byBudget));
}
