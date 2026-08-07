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
   * CU-868kmwdqu — presupuesto de tokens de SALIDA por llamada a Claude, la cota que de
   * verdad limita cuántas filas caben en un lote (ver lib/sheet-batching.ts).
   *
   * 40.000 contra un `max_tokens` de 64.000: el margen del 37% no es timidez, es que la
   * estimación es una heurística sobre el ancho de la hoja y equivocarse por abajo tiene
   * un costo asimétrico — el modelo corta la respuesta, el JSON llega partido y se
   * pierde el documento entero, no solo el lote. Equivocarse por arriba solo cuesta una
   * llamada de más.
   */
  outputTokenBudget: Number(process.env.INTAKE_OUTPUT_TOKEN_BUDGET || 40_000),
  /**
   * Cuántos lotes se mandan a Claude EN PARALELO.
   *
   * Antes los lotes se procesaban en serie y era, medido, el problema más grande de la
   * ingesta desde la vista del cliente. Tres archivos reales en producción (2026-08-06):
   *
   *   Cafe_Andino (1.174 filas, 25 lotes)     68,7 min
   *   Cafeteria_Excel (1.881 filas, 21 lotes) 42,2 min
   *   Reporte preliminar (1.316, 68 lotes)    23,7 min
   *
   * Cada llamada a Claude tarda 140-220 s y no depende de las otras: el cuello es espera
   * de red, no CPU ni base. En serie, 25 lotes × ~165 s son ~69 minutos de alguien mirando
   * una pantalla que dice "procesando".
   *
   * 5 y no 20: el techo real son los límites de tasa de la API de Anthropic, que dependen
   * del tier de la cuenta y no se pueden leer desde acá. El SDK ya reintenta 429/5xx con
   * backoff (`maxRetries` por defecto), así que pasarse no rompe — solo desperdicia
   * latencia en reintentos. 5 baja el archivo de 69 a ~14 minutos y deja margen; se sube
   * por env cuando se mida el límite real de la cuenta, sin tocar código.
   */
  batchConcurrency: Math.max(1, Number(process.env.INTAKE_BATCH_CONCURRENCY || 5)),
};
