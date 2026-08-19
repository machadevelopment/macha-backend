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
 *
 * ═══ 45 → 70, 2026-08-19: EL 45 SE QUEDÓ CORTO Y ESO SE PAGA EN RELOJ, NO EN DINERO ═══
 *
 * Medido contra las 216 llamadas reales del archivo de House Products
 * (`CasaViva_Registro_Operaciones_2025-2026.xlsx`, documento
 * `055d9a75-64b4-49f8-a391-3834346a4d67`, 2026-08-18), leyendo `ai_usage_events`:
 *
 *     salida promedio por llamada   5.364 tokens   (presupuesto: 4.000)
 *     salida máxima                 8.745 tokens   (2,2x el presupuesto)
 *     filas por lote                   88
 *     → tokens de salida por fila      61
 *
 * O sea que el estimador iba 36 % corto en promedio. El razonamiento de arriba sobre la
 * FORMA del objeto sigue siendo correcto; lo que faltó contar es lo que `structured
 * output` agrega alrededor de cada entrada (las comillas de las claves, los separadores,
 * y el hecho de que un `i` de cuatro dígitos y una categoría en snake_case se tokenizan
 * peor de lo que se leen).
 *
 * 70 y no 61: se sigue prefiriendo el lado caro, y el margen cubre la cola larga medida (el
 * máximo observado son 99 tokens/fila, un lote con categorías inusualmente largas).
 *
 * ═══ Y EL PRESUPUESTO SUBE CON ÉL, PORQUE EL LOTE NO ES LA PALANCA DE LATENCIA ═══
 *
 * Corregir el estimador a secas habría encogido el lote de 88 filas a 57, y eso NO es una
 * mejora — es lo que se creía, y es falso. La cuenta, con el rendimiento medido (~115
 * tokens/s de salida) y `batchConcurrency` 10, sobre las 18.034 filas de `Ventas`:
 *
 *     lote   llamadas   tandas   s/llamada   min total
 *       57        317       32          30        16,1
 *       88        205       21          47        16,3
 *       90        201       21          48        16,7
 *      888         21        3         471        23,6
 *
 * Entre 57 y 90 el tiempo de pared es el MISMO. Y tiene que serlo: el total de tokens de
 * salida de una hoja no depende del tamaño del lote, así que
 * `tandas × s_por_llamada ≈ filas × tokens_por_fila / (rendimiento × concurrencia)` — el
 * lote se cancela. Partir más fino no acorta nada; solo multiplica las llamadas, y cada
 * llamada re-envía el prompt de sistema y el bloque de plantilla.
 *
 * Lo que SÍ arruina el tiempo es el otro extremo (888 filas, 23,6 min): con tan pocos lotes
 * ya no hay con qué llenar la ventana de concurrencia, y se espera por llamadas larguísimas
 * en serie. O sea que el trabajo real del presupuesto no es acotar la latencia por llamada
 * —como decía la nota de `config/intake.ts`— sino **mantener suficientes lotes para que la
 * ventana de concurrencia no se quede a medias**, y quedar debajo de `max_tokens`. El
 * 40.000 → 4.000 de agosto fue una mejora real, pero por esa razón y no por la que se
 * escribió.
 *
 * Así que el presupuesto sube a 6.300 en `config/intake.ts` junto con este 70: 6.300/70 = 90
 * filas por llamada, prácticamente las 88 con las que corrió producción. El estimador queda
 * diciendo la verdad y el tamaño de lote no se toca.
 */
const OUTPUT_TOKENS_PER_ROW = 70;

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
