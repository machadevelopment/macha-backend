// Caps de intake de Excel — aprobados por Jose en CU-868kfv972 (2026-07-24), sin
// cambios respecto al default originalmente propuesto. Consumidos por el worker de
// ingesta (T31, Módulo 2), que todavía no existe en este repo.
//
// Reglas de negocio confirmadas (no implementadas aquí, son para T31):
// - Rechazo duro EN LA RECEPCIÓN si se excede cualquier valor: sin encolar job en
//   pg-boss y sin persistir el archivo en S3.
// - El cap de filas se aplica leyendo el atributo `dimension` del XML de cada hoja
//   ANTES de materializar filas — parsear el libro completo para contar ya es procesar.
// - Mensaje de rechazo con el límite y el valor recibido, en el idioma de la empresa
//   (companies.locale).
// - Recalibración futura: los valores se ajustan cuando lleguen los Excels de muestra
//   de Macha, midiendo el percentil 95 de filas y de hojas. No bloquea el arranque.
export const intakeConfig = {
  /** Tamaño máximo de archivo, en MB. */
  maxFileSizeMb: Number(process.env.INTAKE_MAX_FILE_SIZE_MB || 10),
  /** Filas máximas por archivo (todas las hojas). */
  maxRowsPerFile: Number(process.env.INTAKE_MAX_ROWS_PER_FILE || 50_000),
  /** Hojas máximas por libro. Corrección: faltaba en la primera implementación —
   * la tabla de valores de Jose (CU-868kfv972) no llegó completa la primera vez. */
  maxSheetsPerWorkbook: Number(process.env.INTAKE_MAX_SHEETS_PER_WORKBOOK || 30),
  /** A partir de cuántas filas una hoja se considera "grande" y se procesa en lotes. */
  largeSheetRowThreshold: Number(process.env.INTAKE_LARGE_SHEET_ROW_THRESHOLD || 5_000),
  /** Tamaño de lote para hojas grandes. */
  batchSize: Number(process.env.INTAKE_BATCH_SIZE || 2_000),
  /**
   * Presupuesto de tokens de SALIDA por llamada a Claude — la cota que decide cuántas filas
   * caben en un lote (ver lib/sheet-batching.ts).
   *
   * ═══ 40.000 → 4.000, el 2026-08-12, Y NO ES UN AJUSTE COSMÉTICO ═══
   *
   * Al achicar el esquema de salida (lib/row-assembly.ts) el costo por fila cayó de ~290
   * tokens a ~30. Dejar el presupuesto en 40.000 habría convertido TODO ese ahorro en lotes
   * diez veces más grandes: el mismo archivo en menos llamadas, cada una generando los
   * mismos 40.000 tokens y tardando los mismos ~165 segundos. Más barato, sí; igual de
   * lento. Y el cliente lo que ve es el reloj.
   *
   * Porque este número tiene dos trabajos, no uno:
   *
   *   1. EVITAR EL CORTE — que la respuesta quepa en `max_tokens` (64.000). Ese era su
   *      trabajo original y con 4.000 sobra margen.
   *   2. ACOTAR LA LATENCIA DE CADA LLAMADA — el modelo genera token por token (~115 tok/s
   *      medido en producción), así que el presupuesto de salida ES el reloj: 40.000
   *      tokens son ~165 s de espera; 4.000 son ~35 s.
   *
   * Con 4.000 caben ~88 filas por llamada. La hoja `Ventas` de los archivos reales (521
   * filas) sale en 6 lotes y el libro entero en ~10, que a `batchConcurrency` 5 son dos
   * tandas: bajo los 3 minutos que pidió Keneth, contra los ~50 de antes.
   *
   * Subirlo vuelve a alargar la espera; bajarlo multiplica las llamadas (y el prompt de
   * sistema se re-envía en cada una, aunque el caché de prefijo absorbe casi todo eso).
   *
   * ═══ 4.000 → 6.300, 2026-08-19: EL TRABAJO 2 DE ARRIBA ESTÁ MAL DESCRITO ═══
   *
   * La medición de las 216 llamadas reales de House Products (ver `lib/sheet-batching.ts`)
   * dejó ver que "el presupuesto de salida ES el reloj" no se sostiene. El total de tokens de
   * salida de una hoja no depende del tamaño del lote, así que
   * `tandas × s_por_llamada ≈ filas × tokens_por_fila / (rendimiento × concurrencia)`: el
   * lote se cancela y el tiempo de pared sale igual. Medido sobre `Ventas` (18.034 filas,
   * ~115 tok/s, concurrencia 10): lotes de 57 filas → 16,1 min; de 88 → 16,3 min; de 90 →
   * 16,7 min. Partir más fino no acorta nada.
   *
   * Lo que sí arruina el tiempo es quedarse con MENOS lotes que la ventana de concurrencia:
   * con lotes de 888 filas son 21 llamadas en 3 tandas de ~471 s = 23,6 min, porque ya no hay
   * con qué llenar los 10 cupos. Ese —y no la latencia por llamada— es el trabajo 2 de este
   * número. El 40.000 → 4.000 de agosto fue una mejora real, pero por este motivo.
   *
   * El 6.300 sale de mantener el lote donde estaba mientras el estimador se corrige: subió a
   * 70 tokens/fila (era 45, medido: 61), y 6.300/70 = 90 filas por llamada — prácticamente
   * las 88 con las que corrió producción. Sin este ajuste, corregir el estimador habría
   * encogido el lote a 57 y multiplicado las llamadas un 54 % sin ganar un segundo.
   */
  outputTokenBudget: Number(process.env.INTAKE_OUTPUT_TOKEN_BUDGET || 6_300),
  /**
   * Cuántos lotes se mandan a Claude EN PARALELO.
   *
   * Antes los lotes iban en serie y era, medido, el problema más grande de la ingesta desde
   * la vista del cliente. Tres archivos reales en producción (2026-08-06):
   *
   *   Cafe_Andino (1.174 filas, 25 lotes)     68,7 min
   *   Cafeteria_Excel (1.881 filas, 21 lotes) 42,2 min
   *   Reporte preliminar (1.316, 68 lotes)    23,7 min
   *
   * Cada llamada es espera de red, no CPU ni base: en serie, 25 lotes son alguien mirando una
   * pantalla que dice "procesando".
   *
   * ═══ 5 → 10, Y AHORA CON EL LÍMITE MEDIDO EN VEZ DE SUPUESTO (2026-08-12) ═══
   *
   * El 5 se eligió a ciegas: "el techo son los límites de tasa de Anthropic, que dependen del
   * tier y no se pueden leer desde acá". Sí se pueden — vienen en las cabeceras
   * `anthropic-ratelimit-*` de cualquier respuesta. Leídas de la cuenta real:
   *
   *   salida    400.000 tokens/min
   *   entrada 2.000.000 tokens/min
   *   requests      1.000/min
   *
   * El archivo completo, corrido de punta a punta, consumió ~33.000 tokens de salida por
   * minuto: el 8 % del límite. La concurrencia 5 no estaba protegiendo de nada.
   *
   * 10 y no 46 (que es donde el cálculo dice que se toca el techo con un solo archivo): el
   * límite es de CUENTA, no de documento. Varias empresas subiendo a la vez comparten esos
   * 400.000, y con 10 hay margen para varias cargas simultáneas antes de ver un 429. El SDK
   * ya reintenta 429/5xx con backoff, así que pasarse degrada en vez de romper — pero un
   * reintento es tiempo perdido, que es justo lo que se está tratando de recuperar.
   *
   * Medido sobre el archivo real: 10 lotes en UNA tanda en vez de dos. ~72 s → ~35 s.
   *
   * El tope duro de 46 sale de ese mismo límite: cada llamada produce ~4.000 tokens de salida
   * en ~28 s, o sea ~8.600 por minuto sostenidos. Está acá para que subir la variable de
   * entorno sin pensar no convierta la ingesta en una fábrica de 429.
   */
  batchConcurrency: Math.min(46, Math.max(1, Number(process.env.INTAKE_BATCH_CONCURRENCY || 10))),
};
