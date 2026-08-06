/**
 * CU-868kfv972: el mensaje de rechazo debe mostrar el límite y el valor recibido, en
 * el idioma de la empresa (`companies.locale`). El backend no tiene librería de i18n
 * (eso es del frontend, ver CLAUDE.md) — este es un diccionario mínimo, acotado a los
 * errores de intake.
 *
 * Extraído de `modules/ingestion/index.ts` en CU-868kh8man: ahora también lo necesita
 * el worker de ingesta, que es donde se validan los caps de los formatos que no se
 * pueden inspeccionar barato en la recepción (`.xls`).
 */
export const INTAKE_MESSAGES = {
  es: {
    unsupportedType: (mime: string) =>
      `Tipo de archivo no soportado: ${mime}. Usa .xlsx, .xls o .csv.`,
    fileTooLarge: (limitMb: number, receivedMb: number) =>
      `El archivo supera el tamaño máximo permitido (${limitMb} MB). Recibido: ${receivedMb.toFixed(2)} MB.`,
    tooManySheets: (limit: number, received: number) =>
      `El libro supera el máximo de hojas permitidas (${limit}). Recibido: ${received}.`,
    tooManyRows: (limit: number, received: number) =>
      `El archivo supera el máximo de filas permitidas (${limit}). Recibido: ${received}.`,
    insufficientCredits: (required: number, balance: number) =>
      `Saldo de créditos insuficiente para procesar este archivo (requiere ~${required}, disponible: ${balance}).`,
    queueFull: (max: number) => `Ya tienes ${max} archivos procesándose. Espera a que terminen.`,
    // CU-868kjc6h1: el archivo menciona una moneda que la empresa no puede convertir
    // porque nunca se registró una tasa. Se rechaza en la recepción, antes de gastar
    // una sola llamada de IA en un documento que moriría al promoverse.
    missingFxRate: (quote: string, base: string) =>
      `El archivo incluye montos en ${quote}, pero esta empresa (base ${base}) no tiene ninguna ` +
      `tasa de cambio registrada. Pide al equipo de Macha que registre la tasa ${quote}→${base} ` +
      `y vuelve a subir el archivo.`,
    // La salida de escape: el motor sí intentó clasificar y no encontró nada que
    // clasificar. El texto NO culpa al cliente ni le pide reintentar (reintentar el
    // mismo archivo da el mismo resultado) — le da la única acción que sirve.
    unsupportedContent: (reason: string | null) =>
      `No pudimos leer movimientos financieros en este archivo${reason ? `: ${reason}` : '.'}` +
      ` Descarga la plantilla de esta pantalla, llénala con tus movimientos y súbela.`,
  },
  en: {
    unsupportedType: (mime: string) => `Unsupported file type: ${mime}. Use .xlsx, .xls or .csv.`,
    fileTooLarge: (limitMb: number, receivedMb: number) =>
      `File exceeds the maximum allowed size (${limitMb} MB). Received: ${receivedMb.toFixed(2)} MB.`,
    tooManySheets: (limit: number, received: number) =>
      `Workbook exceeds the maximum allowed sheets (${limit}). Received: ${received}.`,
    tooManyRows: (limit: number, received: number) =>
      `File exceeds the maximum allowed rows (${limit}). Received: ${received}.`,
    insufficientCredits: (required: number, balance: number) =>
      `Insufficient credit balance to process this file (requires ~${required}, available: ${balance}).`,
    queueFull: (max: number) =>
      `You already have ${max} files processing. Wait for them to finish.`,
    missingFxRate: (quote: string, base: string) =>
      `The file includes amounts in ${quote}, but this company (base ${base}) has no exchange ` +
      `rate on record. Ask the Macha team to register the ${quote}→${base} rate and upload the ` +
      `file again.`,
    unsupportedContent: (reason: string | null) =>
      `We couldn't find any financial movements in this file${reason ? `: ${reason}` : '.'}` +
      ` Download the template on this screen, fill it in with your movements and upload it.`,
  },
} as const;

export type IntakeLocale = keyof typeof INTAKE_MESSAGES;

/**
 * Junta las razones de "no procesable" que reportó el modelo en una sola frase.
 *
 * Función aparte —y no un `.join()` en línea en el worker— por lo mismo que
 * `assertNotTruncated` en lib/anthropic.ts: lo que hay que poder probar es la regla,
 * no el worker. Un libro de doce hojas de notas devuelve doce veces la misma frase, y
 * lo que el cliente debe leer es una explicación, no un muro.
 */
export function summarizeUnusableReasons(reasons: Iterable<string>): string | null {
  const unique = [...new Set(reasons)].map((r) => r.trim()).filter((r) => r.length > 0);
  if (unique.length === 0) return null;
  return unique.slice(0, 2).join(' ');
}
