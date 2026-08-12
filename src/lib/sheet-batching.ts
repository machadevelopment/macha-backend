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
 * ═══ RECALIBRADO OTRA VEZ, 2026-08-12: AHORA EL ANCHO NO IMPORTA NADA ═══
 *
 * Las dos calibraciones anteriores (300 fijos + 8 por celda) eran correctas para el esquema
 * de entonces: el modelo devolvía la fila RECONSTRUIDA, así que su salida crecía con el
 * contenido de la fila. Ese esquema ya no existe — ver lib/row-assembly.ts.
 *
 * Hoy el modelo devuelve por fila un objeto de forma FIJA:
 *
 *     {"i":123,"e":"transaction","t":"revenue","c":"ventas_mostrador","cf":0.95}
 *
 * Eso son ~30 tokens midiendo el peor caso creíble (categoría larga en snake_case), y son
 * los mismos 30 para una hoja de 3 columnas que para una de 30: el único campo de largo
 * variable es la categoría, que no depende del ancho de la hoja. Por eso el término por
 * celda se va a CERO en vez de encogerse — dejarlo pequeño sería seguir modelando una
 * relación que ya no existe, y partiría de más las hojas anchas sin ninguna razón.
 *
 * 45 y no 30: el margen cubre la categoría inusualmente larga y el `columns` que viene una
 * vez por respuesta (~60 tokens, que repartidos entre las filas del lote son ruido). El
 * error sigue siendo asimétrico y se sigue prefiriendo el lado caro.
 */
const OUTPUT_TOKENS_PER_ROW = 45;

export function estimatedOutputTokensPerRow(_rows: unknown[][]): number {
  // Recibe las filas y no las usa: la firma se conserva porque el costo de salida SÍ podría
  // volver a depender del contenido si el esquema cambiara, y el día que eso pase el ajuste
  // es acá adentro y no en los llamadores.
  return OUTPUT_TOKENS_PER_ROW;
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
