import { describe, expect, test } from 'bun:test';

process.env.DATABASE_URL ??= 'postgres://smoke:smoke@localhost:5432/smoke';
process.env.WORKOS_JWKS_URL ??= 'https://example.invalid/jwks';

const { verifyBearerOr401 } = await import('./bearer');
const { InvalidTokenError, JwksNotConfiguredError } = await import('@/lib/auth-errors');

/** Sustituto mínimo del `set` de Elysia: solo interesa qué status queda escrito. */
const nuevoSet = () => ({ status: undefined as number | string | undefined }) as never;

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
  test('sin cabecera Authorization responde 401, no 500', async () => {
    const set = nuevoSet();
    const err = await capturar(() => verifyBearerOr401(undefined, set));
    expect(err).toBeInstanceOf(InvalidTokenError);
    expect((set as { status?: number }).status).toBe(401);
  });

  test('una cabecera que no es Bearer también es 401', async () => {
    const set = nuevoSet();
    await capturar(() => verifyBearerOr401('Basic dXNlcjpwYXNz', set));
    expect((set as { status?: number }).status).toBe(401);
  });

  test('un token inverificable responde 401', async () => {
    // El JWKS apunta a un host inexistente, así que `jwtVerify` falla — igual que
    // fallaría con un token vencido o firmado por otro emisor.
    const set = nuevoSet();
    const err = await capturar(() => verifyBearerOr401('Bearer token.que.no.sirve', set));
    expect(err).toBeInstanceOf(InvalidTokenError);
    expect((set as { status?: number }).status).toBe(401);
  });

  test('el mensaje no filtra el texto interno de jose', async () => {
    // Lo que llegaba al navegador era `"exp" claim timestamp check failed`.
    const err = (await capturar(() =>
      verifyBearerOr401('Bearer token.que.no.sirve', nuevoSet()),
    )) as Error;
    expect(err.message).not.toContain('claim');
    expect(err.message).not.toContain('exp');
    expect(err.message).not.toContain('JWK');
  });

  test('el mensaje le dice a la persona qué hacer', async () => {
    const err = (await capturar(() => verifyBearerOr401(undefined, nuevoSet()))) as Error;
    expect(err.message.toLowerCase()).toContain('iniciar sesión');
  });

  test('la causa original se conserva para Sentry', async () => {
    const err = (await capturar(() =>
      verifyBearerOr401('Bearer token.que.no.sirve', nuevoSet()),
    )) as { cause_?: unknown };
    expect(err.cause_).toBeDefined();
  });
});

describe('un fallo de CONFIGURACIÓN no se disfraza de 401 (CU-868kmvaf7)', () => {
  test('JwksNotConfiguredError es un tipo distinto de InvalidTokenError', () => {
    // Si una WORKOS_JWKS_URL mal puesta respondiera 401, el diagnóstico sería "los
    // usuarios tienen tokens malos" cuando en realidad no se puede verificar ninguno.
    const config = new JwksNotConfiguredError();
    expect(config).not.toBeInstanceOf(InvalidTokenError);
    expect(config.name).toBe('JwksNotConfiguredError');
  });
});
