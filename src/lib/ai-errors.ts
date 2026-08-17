/**
 * CU-868kmr192: el error del proveedor de IA nunca sale tal cual al cliente.
 *
 * Antes sí salía. `POST /insights` respondía, textualmente:
 *
 *   400 {"type":"error","error":{"type":"invalid_request_error",
 *        "message":"Your credit balance is too low to access the Anthropic API.
 *                   Please go to Plans & Billing to upgrade or purchase credits."},
 *        "request_id":"req_011Cdk2qZVACtDX44Se4jZye"}
 *
 * Tres cosas mal a la vez: le dice al cliente —que tiene créditos de Macha de sobra— que
 * se quedó sin saldo; expone qué proveedor hay detrás junto con su `request_id`; y
 * presenta como 400 (culpa del cliente) lo que es un fallo de infraestructura nuestra.
 *
 * `runAi` envuelve TODA llamada al SDK. Traduce el fallo a un error de dominio con un
 * mensaje que se le puede enseñar a cualquiera, y deja el original en `cause` para que
 * el log y Sentry sí tengan el detalle.
 */

/** Por qué falló, que es lo que decide el status HTTP y si tiene sentido reintentar. */
export type AiFailure =
  | 'not_configured' // falta o es inválida la API key, o la cuenta no tiene saldo → nuestro
  | 'unavailable' // el proveedor está caído o dio 5xx → nuestro, transitorio
  | 'rate_limited' // 429 del proveedor → transitorio
  | 'too_large' // la petición excede el contexto del modelo → del contenido
  | 'incomplete' // la llamada salió BIEN pero el texto llegó cortado o vacío → inservible
  | 'invalid'; // cualquier otro 4xx → programación nuestra

export class AiProviderError extends Error {
  constructor(
    readonly failure: AiFailure,
    readonly operation: string,
    options?: { cause?: unknown },
  ) {
    super(`La operación de IA "${operation}" falló: ${failure}`, options);
    this.name = 'AiProviderError';
  }
}

/** Status HTTP. `not_configured` y `unavailable` son 503: el cliente no hizo nada mal. */
export function aiFailureStatus(failure: AiFailure): number {
  switch (failure) {
    case 'rate_limited':
      return 429;
    case 'too_large':
      return 413;
    // `incomplete` cae acá, en 503 y no en un 4xx, porque el contenido del cliente no tiene
    // la culpa de que el modelo se quedara sin presupuesto de salida — y reintentar es
    // exactamente lo que corresponde.
    case 'invalid':
    case 'not_configured':
    case 'unavailable':
    case 'incomplete':
      return 503;
  }
}

/**
 * Lo único que ve el cliente. Sin nombrar al proveedor, sin `request_id`, y sin sugerir
 * que el problema es suyo cuando no lo es.
 */
export function aiFailureMessage(failure: AiFailure): string {
  switch (failure) {
    case 'rate_limited':
      return 'El servicio de análisis está recibiendo demasiadas solicitudes. Intenta de nuevo en un momento.';
    case 'too_large':
      return 'El contenido es demasiado extenso para analizarlo de una sola vez. Divídelo en partes más pequeñas.';
    // Caso EXPLÍCITO aunque el `default` de abajo diría algo aceptable: el mensaje genérico
    // ("no está disponible") describe mal lo que pasó —el servicio respondió— y el usuario
    // que lo lea después de esperar la generación de un reporte merece saber que reintentar
    // es exactamente lo que hay que hacer.
    case 'incomplete':
      return 'La respuesta llegó incompleta y no se guardó. Vuelve a intentarlo.';
    default:
      return 'El servicio de análisis no está disponible en este momento. Intenta de nuevo más tarde.';
  }
}

/** Forma mínima de un error del SDK de Anthropic; evita importar el tipo solo para esto. */
interface SdkErrorLike {
  status?: number;
  message?: string;
}

export function classifyAiError(error: unknown): AiFailure {
  const e = error as SdkErrorLike;
  const status = typeof e?.status === 'number' ? e.status : undefined;
  const msg = typeof e?.message === 'string' ? e.message.toLowerCase() : '';

  // El saldo agotado llega como 400 `invalid_request_error`, no como 401/402: sin este
  // caso especial se clasificaría como error de programación nuestro y no como lo que
  // es —una cuenta sin fondos— que es justo el fallo que originó este ticket.
  if (msg.includes('credit balance is too low') || msg.includes('billing')) return 'not_configured';
  if (status === 401 || status === 403) return 'not_configured';
  if (status === 429) return 'rate_limited';
  if (status === 413) return 'too_large';
  if (msg.includes('prompt is too long') || msg.includes('exceeds the maximum')) return 'too_large';
  if (status !== undefined && status >= 500) return 'unavailable';
  if (status !== undefined && status >= 400) return 'invalid';
  return 'unavailable'; // sin status: se cayó la red o expiró el tiempo de espera
}

/**
 * Envuelve una llamada al proveedor. `operation` identifica el call site en Sentry —
 * no viaja al cliente.
 */
export async function runAi<T>(operation: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof AiProviderError) throw error;
    throw new AiProviderError(classifyAiError(error), operation, { cause: error });
  }
}
