/**
 * CU-868kmxu41 — el proveedor de pagos no está configurado.
 *
 * EL BUG. En producción, `POST /register` devolvía **500 con el texto interno literal**:
 *
 *   "RECURRENTE_SECRET_KEY not configured — cannot call the Recurrente API.
 *    Set a test key to develop against their sandbox."
 *
 * Dos fallos en una sola respuesta, y ninguno menor:
 *
 * 1. **El registro entero se cae.** Ninguna empresa nueva podía darse de alta, así que
 *    ningún cliente piloto podía entrar a probar el producto ni dar feedback.
 * 2. **Se filtra al navegador el nombre de la variable de entorno y una pista sobre
 *    claves de sandbox.** Es la MISMA clase de bug que CU-868kmr192, donde el error de
 *    facturación de Anthropic llegaba literal al cliente. Un error de configuración del
 *    servidor no es información del usuario: no puede hacer nada con ella, y le dice a
 *    cualquiera que pruebe el endpoint cómo está montado el backend por dentro.
 *
 * Tipo propio para que `app.ts` pueda traducirlo a una respuesta limpia antes de
 * responder, igual que se hace con `AiProviderError`. La causa técnica sigue yendo a
 * Sentry completa; lo que se recorta es lo que cruza la red.
 */
export class BillingNotConfiguredError extends Error {
  constructor() {
    super('El proveedor de pagos no está configurado en este entorno.');
    this.name = 'BillingNotConfiguredError';
  }
}

/**
 * 503 y no 500: no es que el servidor se haya roto, es que una dependencia externa no
 * está disponible en este entorno. La diferencia importa para quien monitorea.
 */
export const BILLING_NOT_CONFIGURED_STATUS = 503;

/**
 * Lo que ve el usuario. Deliberadamente sin nombres de variables ni de proveedor, y
 * SIN "intenta de nuevo": reintentar no lo va a arreglar nunca, y esa frase —que es la
 * que mostraba el formulario— hacía que la persona insistiera contra un muro.
 */
export const BILLING_NOT_CONFIGURED_MESSAGE =
  'El registro no está disponible en este momento. Escríbenos y te damos de alta.';
