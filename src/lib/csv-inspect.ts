const QUOTE = 0x22; // "
const LF = 0x0a; // \n
const CR = 0x0d; // \r

/**
 * CU-868kh8man: cuenta registros de un CSV sin materializar filas ni decodificar el
 * archivo entero a string — escanea bytes. Complemento de `inspectXlsxWorkbook`, que
 * solo funciona sobre `.xlsx` (zip OOXML): antes de esto, un `.csv` solo pasaba por el
 * cap de tamaño, así que uno de 9 MB con cientos de miles de filas se aceptaba pese a
 * `INTAKE_MAX_ROWS_PER_FILE`.
 *
 * Respeta el entrecomillado de RFC 4180: un salto de línea DENTRO de un campo entre
 * comillas no separa registros. Contar `\n` a secas daría de más en cualquier CSV con
 * descripciones multilínea — justo el tipo de archivo que manda una pyme.
 *
 * Cuenta el registro final aunque no termine en salto de línea, y no cuenta una línea
 * final vacía (el caso normal de un archivo que sí termina en `\n`).
 */
export function countCsvRows(buffer: Uint8Array): number {
  let rows = 0;
  let inQuotes = false;
  let recordHasContent = false;

  for (let i = 0; i < buffer.length; i++) {
    const byte = buffer[i]!;

    if (inQuotes) {
      if (byte === QUOTE) {
        // "" dentro de un campo entrecomillado es una comilla escapada, no el cierre.
        if (buffer[i + 1] === QUOTE) i++;
        else inQuotes = false;
      }
      recordHasContent = true;
      continue;
    }

    if (byte === QUOTE) {
      inQuotes = true;
      recordHasContent = true;
    } else if (byte === LF) {
      rows++;
      recordHasContent = false;
    } else if (byte === CR) {
      // CRLF cuenta una sola vez: deja que lo cierre el LF que viene.
      if (buffer[i + 1] === LF) continue;
      rows++; // CR solo (CSV de Mac clásico)
      recordHasContent = false;
    } else {
      recordHasContent = true;
    }
  }

  // Último registro sin salto de línea final.
  if (recordHasContent) rows++;
  return rows;
}
