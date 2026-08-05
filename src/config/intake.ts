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
};
