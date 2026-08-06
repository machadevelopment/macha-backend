/**
 * CU-868kmvaf7 — errores de autenticación, en un módulo aparte de `auth.ts`.
 *
 * La separación no es estética. Los tests de integración mockean `@/lib/auth` entero
 * para sustituir `verifyToken` por un doble, y si las clases vivieran ahí el mock las
 * dejaría en `undefined`: `new InvalidTokenError()` reventaría y `instanceof` daría
 * siempre falso, silenciosamente. Viviendo aquí, mockear `verifyToken` no toca los
 * tipos — que es justo lo que se quiere poder mockear y lo que no.
 */

/**
 * El token que presenta el cliente no sirve: vencido, firma inválida, emisor
 * equivocado. Es un error DEL CLIENTE y termina en 401.
 *
 * El mensaje NO lleva el texto de `jose` (`"exp" claim timestamp check failed`): eso es
 * detalle interno de una librería, no información que el usuario pueda usar.
 */
export class InvalidTokenError extends Error {
  constructor(readonly cause_?: unknown) {
    super('Sesión inválida o vencida. Vuelve a iniciar sesión.');
    this.name = 'InvalidTokenError';
  }
}

/**
 * Fallo de CONFIGURACIÓN del servidor, no del cliente. Nunca es un 401.
 *
 * Se distingue de `InvalidTokenError` aunque las dos salgan de `verifyToken`, porque
 * son opuestas: si una `WORKOS_JWKS_URL` mal puesta respondiera 401, el diagnóstico
 * sería "los usuarios tienen tokens malos" cuando en realidad no se puede verificar
 * ninguno.
 */
export class JwksNotConfiguredError extends Error {
  constructor() {
    super('WORKOS_JWKS_URL not configured — cannot verify any token.');
    this.name = 'JwksNotConfiguredError';
  }
}
