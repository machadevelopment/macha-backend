import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import { env } from './env';
import { InvalidTokenError, JwksNotConfiguredError } from './auth-errors';

export { InvalidTokenError, JwksNotConfiguredError } from './auth-errors';

// WorkOS/AuthKit JWTs are verified against JWKS per request. No passwords anywhere.
const jwks = env.workosJwksUrl ? createRemoteJWKSet(new URL(env.workosJwksUrl)) : null;

export interface VerifiedToken extends JWTPayload {
  sub: string; // workos_user_id
}

export async function verifyToken(token: string): Promise<VerifiedToken> {
  if (!jwks) throw new JwksNotConfiguredError();
  try {
    const { payload } = await jwtVerify(token, jwks);
    return payload as VerifiedToken;
  } catch (err) {
    // `jwtVerify` lanza por token vencido, firma inválida, emisor equivocado y también
    // por fallos de red al traer el JWKS. Los primeros son del cliente; el último no,
    // pero desde aquí no se distinguen sin inspeccionar códigos internos de `jose`. Se
    // trata como error de cliente a propósito: un 401 hace que el frontend renueve la
    // sesión, que es la recuperación correcta en el caso frecuente. La causa original
    // viaja adjunta para que Sentry conserve el detalle.
    throw new InvalidTokenError(err);
  }
}
