import { describe, expect, test } from 'bun:test';

process.env.DATABASE_URL ??= 'postgres://smoke:smoke@localhost:5432/smoke';

const { checkTokenBucket, reportRateLimited, enforceTokenBucket, rateLimitedResponse } =
  await import('./rate-limit');
const { rateLimitConfig } = await import('@/config/rate-limit');

/**
 * CU-868kh8qhp criterio 3. El bucket se inyecta como dependencia (`TokenBucketRedis`)
 * en vez de usar `mock.module`, que en `bun test` es global al proceso y se filtraría
 * a los otros 15 archivos de test.
 *
 * Lo que se prueba aquí es la rama de RECHAZO y el cálculo de `retryAfterSeconds`: la
 * aritmética del refill vive en Lua, del lado de Redis, y es el propio Redis quien la
 * ejecuta atómicamente. Eso NO está cubierto por estos tests — queda para la infra de
 * test de integración (CU-868kh8zbj). Lo declaro explícito en vez de dar por cubierto
 * algo que no lo está.
 */
function fakeRedis(reply: [number, number]) {
  const calls: unknown[][] = [];
  return {
    calls,
    eval: (...args: unknown[]) => {
      calls.push(args);
      return Promise.resolve(reply);
    },
  };
}

describe('checkTokenBucket (CU-868kh8qhp — rate limiting de la API de lectura)', () => {
  test('permite cuando Redis reporta allowed=1', async () => {
    const redis = fakeRedis([1, 42]);
    const result = await checkTokenBucket('read', 'company-a', redis);
    expect(result).toEqual({ allowed: true, retryAfterSeconds: 0 });
  });

  test('rechaza cuando el bucket está agotado', async () => {
    const redis = fakeRedis([0, 0]);
    const result = await checkTokenBucket('read', 'company-a', redis);
    expect(result.allowed).toBe(false);
  });

  test('el Retry-After de un bucket agotado es al menos 1 segundo, nunca 0', async () => {
    // Con tokensLeft justo por debajo de 1 el déficit es de milisegundos; redondear
    // hacia abajo daría Retry-After: 0 y el cliente reintentaría en bucle.
    const redis = fakeRedis([0, 0.999]);
    const { retryAfterSeconds } = await checkTokenBucket('read', 'company-a', redis);
    expect(retryAfterSeconds).toBeGreaterThanOrEqual(1);
  });

  test('el Retry-After crece con el déficit de tokens', async () => {
    const empty = await checkTokenBucket('read', 'company-a', fakeRedis([0, 0]));
    const almost = await checkTokenBucket('read', 'company-a', fakeRedis([0, 0.5]));
    expect(empty.retryAfterSeconds).toBeGreaterThanOrEqual(almost.retryAfterSeconds);
  });

  test('llavea el bucket por company_id — dos empresas no comparten cupo', async () => {
    const a = fakeRedis([1, 10]);
    const b = fakeRedis([1, 10]);
    await checkTokenBucket('read', 'company-a', a);
    await checkTokenBucket('read', 'company-b', b);
    expect(a.calls[0]?.[2]).toBe('rl:read:company-a');
    expect(b.calls[0]?.[2]).toBe('rl:read:company-b');
  });

  test('usa la capacidad configurada de cada bucket (read y ai son distintos)', async () => {
    const read = fakeRedis([1, 1]);
    const ai = fakeRedis([1, 1]);
    await checkTokenBucket('read', 'company-a', read);
    await checkTokenBucket('ai', 'company-a', ai);
    expect(read.calls[0]?.[3]).toBe(rateLimitConfig.tokenBucket.read.burst);
    expect(ai.calls[0]?.[3]).toBe(rateLimitConfig.tokenBucket.ai.burst);
    // El bucket de IA es estricto y el de lectura generoso — si esto se invierte por
    // accidente, el dashboard se ahoga y la IA se abarata, que es el error caro.
    expect(rateLimitConfig.tokenBucket.ai.burst).toBeLessThan(
      rateLimitConfig.tokenBucket.read.burst,
    );
  });
});

describe('reportRateLimited (CU-868kh92fz — los 429 dejan rastro)', () => {
  test('es no-op sin SENTRY_DSN: no lanza ni rompe la respuesta al cliente', () => {
    // Local y CI nunca setean DSN. Un fallo de observabilidad jamás debe convertir un
    // 429 legítimo en un 500.
    expect(() =>
      reportRateLimited({
        mechanism: 'token_bucket',
        companyId: 'company-a',
        route: 'GET /metrics',
        detail: 'read',
      }),
    ).not.toThrow();
  });

  test('acepta los dos mecanismos acordados en CU-868kfv97f', () => {
    for (const mechanism of ['token_bucket', 'queue_gate'] as const) {
      expect(() =>
        reportRateLimited({
          mechanism,
          companyId: 'company-a',
          route: 'POST /documents',
          detail: 'excel',
        }),
      ).not.toThrow();
    }
  });
});

describe('rateLimitedResponse (contrato del 429)', () => {
  test('el esquema fija error y retryAfterSeconds', () => {
    expect(Object.keys(rateLimitedResponse.properties)).toEqual(['error', 'retryAfterSeconds']);
    expect(rateLimitedResponse.properties.error.const).toBe('rate_limited');
  });

  test('enforceTokenBucket está exportado para que las rutas no repitan el 429 a mano', () => {
    expect(typeof enforceTokenBucket).toBe('function');
  });
});
