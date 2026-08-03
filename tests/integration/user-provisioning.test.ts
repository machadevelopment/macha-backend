import { describe, expect, test, beforeAll, afterAll, mock } from 'bun:test';
import { Elysia } from 'elysia';
import { setupTestDatabase, ownerConnection, testOwnerUrl, testAppUrl } from './setup';

/**
 * CU-868kjkfdf criterio 4: arrancar SIN fila en `users` y comprobar que la identidad se
 * da de alta sola.
 *
 * Este es el hueco exacto por el que el bug sobrevivió a 63 tests de integración: todos
 * los demás archivos insertan su usuario con SQL crudo en el `beforeAll`, así que
 * ejercitan los guards **saltándose el paso que faltaba**. Aquí no se inserta ninguno a
 * propósito — si el alta JIT desaparece, esto vuelve a dar 403 y falla.
 *
 * Corre con el rol `macha_app`, que es el que importa: `users` no tiene RLS, pero sí
 * depende del GRANT de INSERT de la migración 0010.
 */

process.env.DATABASE_URL = testOwnerUrl;
process.env.APP_DATABASE_URL = testAppUrl;
process.env.WORKOS_JWKS_URL = 'https://example.invalid/jwks';

/** El "token" es literalmente el workos_user_id — basta para ejercitar el guard. */
mock.module('@/lib/auth', () => ({
  verifyToken: async (token: string) => ({ sub: token }),
}));

/**
 * Se mockea el perfil de WorkOS, no la base: lo que se prueba es el alta contra Postgres
 * real. La llamada de red es de WorkOS y ya tiene su propio test de contrato
 * (src/lib/workos-users.test.ts).
 */
let fetchCalls = 0;
mock.module('@/lib/workos-users', () => ({
  fetchWorkosUser: async (workosUserId: string) => {
    fetchCalls++;
    return { email: `${workosUserId}@example.test`, name: 'Persona de Prueba' };
  },
}));

const { identityDerive } = await import('@/guards/identity.derive');
const { users } = await import('@/db/schema');
const { eq } = await import('drizzle-orm');

// Handler mínimo: solo devuelve lo que el guard resolvió. Lo que se está probando es el
// guard, no el módulo /me.
const app = new Elysia().use(identityDerive).get('/whoami', ({ userId }) => ({ userId }));

const NUEVO = 'user_01JIT_NUEVO';
const OTRO = 'user_01JIT_OTRO';

const owner = ownerConnection();

beforeAll(async () => {
  await setupTestDatabase();
  // Deliberadamente NO se inserta ninguna fila en `users`.
  await owner`delete from company_users where true`;
  await owner`delete from users where workos_user_id in (${NUEVO}, ${OTRO})`;
});

afterAll(async () => {
  await owner.end();
});

const whoami = (token: string) =>
  app.handle(
    new Request('http://localhost/whoami', { headers: { authorization: `Bearer ${token}` } }),
  );

describe('alta JIT de una identidad de WorkOS', () => {
  test('una identidad nunca vista obtiene su fila y ya no recibe 403', async () => {
    const res = await whoami(NUEVO);
    expect(res.status).toBe(200);

    const rows = await owner`select * from users where workos_user_id = ${NUEVO}`;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.email).toBe(`${NUEVO}@example.test`);
    expect(rows[0]!.name).toBe('Persona de Prueba');
  });

  test("locale nace en 'es' — WorkOS no expone idioma; /register lo corrige después", async () => {
    const rows = await owner`select locale from users where workos_user_id = ${NUEVO}`;
    expect(rows[0]!.locale).toBe('es');
  });

  test('la segunda visita reusa la fila y NO vuelve a llamar a WorkOS', async () => {
    const callsAntes = fetchCalls;
    const res = await whoami(NUEVO);
    expect(res.status).toBe(200);
    expect(fetchCalls).toBe(callsAntes);

    const rows = await owner`select id from users where workos_user_id = ${NUEVO}`;
    expect(rows).toHaveLength(1);
  });

  /**
   * El frontend dispara varias llamadas al montar, así que dos requests del mismo
   * usuario nuevo pueden entrar a la vez con la fila todavía sin existir. El árbitro es
   * el índice único, no un "if not exists" en la app.
   */
  test('dos requests simultáneos de la misma identidad nueva crean UNA sola fila', async () => {
    const [a, b] = await Promise.all([whoami(OTRO), whoami(OTRO)]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);

    const rows = await owner`select id from users where workos_user_id = ${OTRO}`;
    expect(rows).toHaveLength(1);
  });

  test('el alta funciona con el rol macha_app, no solo con el dueño', async () => {
    // Si el GRANT de INSERT de 0010 se perdiera, el alta fallaría solo bajo macha_app —
    // que es el rol con el que corre la app de verdad.
    const { db } = await import('@/db/client');
    const rows = await db.select().from(users).where(eq(users.workosUserId, OTRO));
    expect(rows).toHaveLength(1);
  });
});
