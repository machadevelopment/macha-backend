import { describe, expect, test } from 'bun:test';
import { Glob } from 'bun';
import { join } from 'node:path';

process.env.DATABASE_URL ??= 'postgres://smoke:smoke@localhost:5432/smoke';

const {
  checkTokenBucket,
  reportRateLimited,
  enforceTokenBucket,
  enforceTokenBucketForUser,
  rateLimitedResponse,
} = await import('./rate-limit');
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

/**
 * CU-868kjby4z. El bug que cierra este ticket no era de lógica sino de CONTRATO: la
 * config declaraba dos kinds gateados y solo uno tenía llamador, así que quien leía
 * `appliesTo` creía que los reportes estaban gateados y no lo estaban. Mismo patrón
 * que CU-868kh8qhp (el bucket `read` configurado y sin usar).
 *
 * Un test de comportamiento no lo habría atrapado —ambas mitades funcionan bien por
 * separado, lo que faltaba era la llamada—, así que se verifica sobre el código: cada
 * kind declarado tiene que aparecer en un `checkQueueGate(..., '<kind>')` real. Si
 * mañana alguien agrega un kind a `appliesTo` sin cablearlo, o borra el único llamador
 * de uno existente, esto falla en vez de quedarse como config que miente.
 *
 * Se excluye `lib/rate-limit.ts` del barrido porque es donde vive la FIRMA de
 * `checkQueueGate` (los kinds aparecen ahí como tipos, no como llamadas) y se contaría
 * a sí misma como consumidor.
 */
describe('queueGate.appliesTo (CU-868kjby4z — ningún kind declarado sin consumidor)', () => {
  const SRC_DIR = join(import.meta.dir, '..');
  const SELF = 'lib/rate-limit.ts';

  async function callersOf(kind: string): Promise<string[]> {
    // `[^)]*` cruza saltos de línea, que es justo lo que se necesita: varias llamadas
    // están partidas en dos líneas por el formateo de prettier.
    const call = new RegExp(String.raw`checkQueueGate\(\s*[^)]*['"]${kind}['"]`);
    const found: string[] = [];
    for await (const rel of new Glob('**/*.ts').scan({ cwd: SRC_DIR })) {
      const path = rel.replaceAll('\\', '/');
      if (path.endsWith('.test.ts') || path === SELF) continue;
      if (call.test(await Bun.file(join(SRC_DIR, rel)).text())) found.push(path);
    }
    return found;
  }

  for (const kind of rateLimitConfig.queueGate.appliesTo) {
    test(`\`${kind}\` tiene al menos un llamador real de checkQueueGate`, async () => {
      // Si esto falla: el kind está declarado en `appliesTo` y ningún archivo de src/
      // lo invoca — o se cablea el llamador, o se saca de la config.
      expect((await callersOf(kind)).length).toBeGreaterThan(0);
    });
  }

  test('el barrido detecta de verdad la ausencia de llamadores (control negativo)', async () => {
    // Sin esto, un regex roto haría pasar los casos de arriba por la razón equivocada.
    expect(await callersOf('kind_que_no_existe')).toEqual([]);
  });

  test('chat e insight NO están declarados en el gate: son interactivos', () => {
    const declared: readonly string[] = rateLimitConfig.queueGate.appliesTo;
    expect(declared).not.toContain('chat');
    expect(declared).not.toContain('insight');
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

/**
 * CU-868kjc950. `/register` no cuelga de `tenantDerive` sino de `identityDerive`: basta
 * cualquier usuario autenticado en WorkOS, sin pertenecer a ninguna empresa. Cada llamada
 * ejecuta `CREATE TABLE ... PARTITION OF` tres veces contra el Postgres compartido, así
 * que sin techo esto es DDL ilimitado sobre la base de TODOS los clientes.
 *
 * El limitador existente no servía tal cual: su clave es la empresa, y aquí todavía no
 * hay empresa. De ahí la variante por usuario.
 */
describe('rate limit por usuario (CU-868kjc950)', () => {
  test('la clave de Redis lleva el prefijo `u:` — usuarios y empresas no comparten cupo', async () => {
    const redis = fakeRedis([1, 5]);
    await checkTokenBucket('register', 'u:user-1', redis);
    // key es el 3er argumento de eval(script, numKeys, key, ...)
    expect(redis.calls[0]![2]).toBe('rl:register:u:user-1');
  });

  test('devuelve 429 con Retry-After cuando el usuario agota el cupo', async () => {
    const redis = fakeRedis([0, 0]);
    const set = { status: 0, headers: {} as Record<string, string> };
    const body = await enforceTokenBucketForUser(
      'register',
      'user-1',
      set as never,
      'POST /register',
      redis,
    );
    expect(set.status).toBe(429);
    expect(body).toEqual({ error: 'rate_limited', retryAfterSeconds: expect.any(Number) });
    expect(set.headers['Retry-After']).toBeDefined();
  });

  test('el cupo de alta de empresas es bajo a propósito: ráfaga de 3', () => {
    expect(rateLimitConfig.tokenBucket.register.burst).toBeLessThanOrEqual(5);
    // 3 por hora expresadas en rpm.
    expect(rateLimitConfig.tokenBucket.register.rpm).toBeLessThan(1);
  });

  test('el top-up tiene bucket propio y más estricto que `ai`', () => {
    expect(rateLimitConfig.tokenBucket.billing.rpm).toBeLessThan(
      rateLimitConfig.tokenBucket.ai.rpm,
    );
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════
 * SI REDIS NO CONTESTA, SE DEJA PASAR — CU-868kt2bf5
 * ═══════════════════════════════════════════════════════════════════════════════════════
 *
 * `checkTokenBucket` no tenía `try/catch`, y esa ausencia era un modo de fallo entero:
 * `redis.eval` lanza ante cualquier tropiezo del servicio, la excepción salía del handler
 * y Elysia respondía **500**. Cualquier parpadeo de Redis tumbaba TODAS las rutas de
 * lectura de TODOS los clientes a la vez.
 *
 * Así se reportó: *"el sistema se cae al escribir un email"* en el flujo de invitación.
 * No era el formulario — `GET /members/` pasa por este bucket y `GET /members/invitations`
 * no, y el panel reemplaza la pantalla entera cuando falla la lista de miembros.
 *
 * Un limitador de tasa que provoca la caída que existe para evitar está al revés.
 */
function redisCaido(mensaje = 'ECONNREFUSED') {
  return {
    eval: () => Promise.reject(new Error(mensaje)),
  };
}

describe('el bucket falla ABIERTO (CU-868kt2bf5)', () => {
  test('si Redis lanza, la petición pasa en vez de reventar', async () => {
    // Antes esto rechazaba la promesa y el handler devolvía 500.
    const result = await checkTokenBucket('read', 'company-a', redisCaido());
    expect(result).toEqual({ allowed: true, retryAfterSeconds: 0 });
  });

  test('`enforceTokenBucket` devuelve null: para el llamador es "seguí"', async () => {
    /*
     * Es la forma que importa: los handlers hacen `if (limited) return limited`, así que
     * `null` es lo único que los deja continuar. Devolver el cuerpo de 429 acá convertiría
     * la caída de Redis en un 429 masivo — mejor que un 500, pero igual de inservible.
     */
    const set = { status: 200, headers: {} as Record<string, string> };
    const limited = await enforceTokenBucket(
      'read',
      'company-a',
      set as never,
      'GET /members/',
      redisCaido(),
    );

    expect(limited).toBeNull();
    expect(set.status).toBe(200);
  });

  test('vale para TODOS los buckets, no solo el de lectura', async () => {
    // `ai` también: dejar caído el chat y los insights por un parpadeo de Redis sería el
    // mismo error. El gasto lo sigue frenando el saldo de créditos, que es de Postgres.
    for (const bucket of ['read', 'ai'] as const) {
      const r = await checkTokenBucket(bucket, 'company-a', redisCaido());
      expect(r.allowed).toBe(true);
    }
  });

  test('un rechazo LEGÍTIMO sigue rechazando', async () => {
    // El contraste que impide que "fallar abierto" se convierta en "no limitar nunca":
    // cuando Redis SÍ contesta y dice que no hay cupo, el 429 se mantiene.
    const result = await checkTokenBucket('read', 'company-a', fakeRedis([0, 0]));
    expect(result.allowed).toBe(false);
  });
});
