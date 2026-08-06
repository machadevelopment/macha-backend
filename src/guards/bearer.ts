import type { Context } from 'elysia';
import { verifyToken, type VerifiedToken } from '@/lib/auth';
// Desde `auth-errors` y NO desde `auth`: los tests de integración mockean `@/lib/auth`
// entero, y sacar las clases de ahí las dejaría en `undefined` sin avisar.
import { InvalidTokenError } from '@/lib/auth-errors';

/**
 * CU-868kmvaf7 — el único lugar donde se convierte un bearer en identidad verificada.
 *
 * EL BUG. Los tres guards (`identity.derive`, `tenant.derive`, `admin.guard`) hacían lo
 * mismo: comprobaban la cabecera, seteaban 401 si faltaba, y luego llamaban a
 * `verifyToken` **sin envolverlo**. Cuando el token estaba vencido —el caso más común
 * que existe, porque los access tokens de WorkOS duran minutos— la excepción salía sin
 * status y el `onError` global devolvía `undefined`, así que Elysia caía a su manejo por
 * defecto: **500 con el mensaje de la excepción como cuerpo**. Visto en producción:
 *
 *     GET /documents/:id -> 500  "exp" claim timestamp check failed
 *
 * Tres consecuencias, y la primera es la que rompe el producto:
 *
 *  1. El frontend lee 500 como "el backend se cayó" y dispara el error boundary de ruta,
 *     en vez de leer 401 y renovar la sesión. La recuperación natural no ocurre.
 *  2. Cada expiración —un evento rutinario, no un fallo— generaba un evento en Sentry.
 *     Con tráfico real eso ahoga los errores de verdad.
 *  3. Fuga menor de internals de `jose`.
 *
 * Vive aquí y no repetido en cada guard para que la próxima ruta que necesite auth no
 * vuelva a olvidar el try/catch: es exactamente así como se coló la primera vez.
 */
export async function verifyBearerOr401(
  authHeader: string | undefined,
  set: Context['set'],
): Promise<VerifiedToken> {
  if (!authHeader?.startsWith('Bearer ')) {
    set.status = 401;
    throw new InvalidTokenError();
  }
  try {
    return await verifyToken(authHeader.slice(7));
  } catch (err) {
    // `JwksNotConfiguredError` NO se captura acá: es un fallo del servidor y tiene que
    // seguir subiendo como 500. Que un error de configuración se disfrace de 401
    // mandaría a investigar a los usuarios en vez de a la variable de entorno.
    if (err instanceof InvalidTokenError) {
      set.status = 401;
    }
    throw err;
  }
}
