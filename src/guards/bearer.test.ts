import { describe, expect, test, mock } from 'bun:test';

process.env.DATABASE_URL ??= 'postgres://smoke:smoke@localhost:5432/smoke';

const { InvalidTokenError, JwksNotConfiguredError } = await import('@/lib/auth-errors');

/**
 * `verifyToken` se sustituye por un doble en vez de dejar que `jose` falle de verdad.
 *
 * No es comodidad: la primera versión de este archivo seteaba `WORKOS_JWKS_URL` y
 * confiaba en que `jwtVerify` reventara. Pasaba en local —donde `.env` trae la
 * variable— y FALLABA en CI, porque `lib/env.ts` congela `process.env` al importarse y
 * `bun test` corre todos los archivos en un proceso: para cuando este archivo asignaba
 * la variable, otro test ya había importado `env`. Con el JWKS sin configurar,
 * `verifyToken` lanzaba `JwksNotConfiguredError` —que el envoltorio NO convierte a 401,
 * a propósito— y las aserciones caían.
 *
 * Lo que hay que probar acá es la CLASIFICACIÓN que hace `verifyBearerOr401`, no el
 * comportamiento de `jose`. Con el doble, el test dice exactamente eso y deja de
 * depender del entorno.
 */
mock.module('@/lib/auth', () => ({
  verifyToken: async (token: string) => {
    if (token === 'valido') return { sub: 'user_123' };
    if (token === 'sin-jwks') throw new JwksNotConfiguredError();
    throw new InvalidTokenError(new Error('"exp" claim timestamp check failed'));
  },
}));

const { verifyBearerOr401 } = await import('./bearer');

/** Sustituto mínimo del `set` de Elysia: solo interesa qué status queda escrito. */
const nuevoSet = () => ({ status: undefined }) as never;
const statusDe = (set: unknown) => (set as { status?: number }).status;

async function capturar(fn: () => Promise<unknown>) {
  try {
    await fn();
    return undefined;
  } catch (err) {
    return err;
  }
}

/**
 * CU-868kmvaf7. En producción, un token vencido devolvía **500** con el texto crudo de
 * `jose` (`"exp" claim timestamp check failed`). El frontend lo leía como "el backend se
 * cayó" y disparaba su error boundary en vez de renovar la sesión — y los access tokens
 * de WorkOS duran minutos, así que era el caso más frecuente que existe.
 */
describe('verifyBearerOr401 (CU-868kmvaf7)', () => {
  test('un token válido pasa y no toca el status', async () => {
    const set = nuevoSet();
    const token = await verifyBearerOr401('Bearer valido', set);
    expect(token.sub).toBe('user_123');
    expect(statusDe(set)).toBeUndefined();
  });

  test('sin cabecera Authorization responde 401, no 500', async () => {
    const set = nuevoSet();
    const err = await capturar(() => verifyBearerOr401(undefined, set));
    expect(err).toBeInstanceOf(InvalidTokenError);
    expect(statusDe(set)).toBe(401);
  });

  test('una cabecera que no es Bearer también es 401', async () => {
    const set = nuevoSet();
    await capturar(() => verifyBearerOr401('Basic dXNlcjpwYXNz', set));
    expect(statusDe(set)).toBe(401);
  });

  test('un token vencido o mal firmado responde 401', async () => {
    const set = nuevoSet();
    const err = await capturar(() => verifyBearerOr401('Bearer vencido', set));
    expect(err).toBeInstanceOf(InvalidTokenError);
    expect(statusDe(set)).toBe(401);
  });

  test('el mensaje no filtra el texto interno de jose', async () => {
    // Lo que llegaba al navegador era `"exp" claim timestamp check failed`.
    const err = (await capturar(() => verifyBearerOr401('Bearer vencido', nuevoSet()))) as Error;
    expect(err.message).not.toContain('claim');
    expect(err.message).not.toContain('exp');
  });

  test('el mensaje le dice a la persona qué hacer', async () => {
    const err = (await capturar(() => verifyBearerOr401(undefined, nuevoSet()))) as Error;
    expect(err.message.toLowerCase()).toContain('iniciar sesión');
  });

  test('la causa original se conserva para Sentry', async () => {
    const err = (await capturar(() => verifyBearerOr401('Bearer vencido', nuevoSet()))) as {
      cause_?: unknown;
    };
    expect(err.cause_).toBeDefined();
  });

  test('un fallo de CONFIGURACIÓN no se disfraza de 401', async () => {
    // Si una `WORKOS_JWKS_URL` mal puesta respondiera 401, el diagnóstico sería "los
    // usuarios tienen tokens malos" cuando en realidad no se puede verificar ninguno.
    const set = nuevoSet();
    const err = await capturar(() => verifyBearerOr401('Bearer sin-jwks', set));
    expect(err).toBeInstanceOf(JwksNotConfiguredError);
    expect(statusDe(set)).toBeUndefined();
  });
});
