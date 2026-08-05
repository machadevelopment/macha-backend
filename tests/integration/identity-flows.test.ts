import { describe, expect, test, beforeAll, afterAll, mock } from 'bun:test';
import { Elysia } from 'elysia';
import { randomUUID } from 'node:crypto';
import { setupTestDatabase, ownerConnection, testOwnerUrl, testAppUrl } from './setup';

/**
 * CU-868kjc4wa: los flujos que viven FUERA de `tenant.derive`, contra Postgres real y
 * con el rol `macha_app`.
 *
 * Son los tres caminos que no tienen empresa resuelta cuando arrancan —el org-switcher
 * porque todavía la está eligiendo, el registro porque la está creando, el webhook
 * porque no hay usuario— y por eso consultaban con el pool pelado. Con `macha_app` eso
 * devolvía cero filas al leer y `new row violates row-level security policy` al
 * escribir. Ninguno de los tres tenía test contra base real: por eso el bug llegó a
 * `main`.
 */

// El env debe quedar seteado ANTES de importar cualquier módulo que lea `env`:
// src/lib/env.ts lo evalúa en el import y src/db/client.ts abre el pool ahí mismo.
process.env.DATABASE_URL = testOwnerUrl;
process.env.APP_DATABASE_URL = testAppUrl;
process.env.WORKOS_JWKS_URL = 'https://example.invalid/jwks';

/** El "token" es literalmente el workos_user_id — basta para ejercitar el guard. */
mock.module('@/lib/auth', () => ({
  verifyToken: async (token: string) => {
    if (token === 'invalid') throw new Error('bad signature');
    return { sub: token };
  },
}));

const { identityDerive } = await import('@/guards/identity.derive');
const { companyUsers, companies, staff } = await import('@/db/schema');
const { eq, and } = await import('drizzle-orm');

// Se monta el handler de /me/memberships aquí en vez de importar el módulo entero:
// lo que se prueba es el guard + la query bajo RLS, sin arrastrar el resto del router.
const app = new Elysia().use(identityDerive).get('/me/memberships', async ({ userId, db }) => {
  const memberships = await db
    .select({
      companyId: companyUsers.companyId,
      companyName: companies.name,
      role: companyUsers.role,
    })
    .from(companyUsers)
    .innerJoin(companies, eq(companies.id, companyUsers.companyId))
    .where(and(eq(companyUsers.userId, userId), eq(companyUsers.status, 'active')));

  const [staffRow] = await db
    .select({ tier: staff.tier })
    .from(staff)
    .where(and(eq(staff.userId, userId), eq(staff.status, 'active')))
    .limit(1);

  return { memberships, staffTier: staffRow?.tier ?? null };
});

function request(path: string, headers: Record<string, string>) {
  return app.handle(new Request(`http://localhost${path}`, { headers }));
}

describe('flujos de identidad con el rol macha_app (CU-868kjc4wa)', () => {
  let owner: ReturnType<typeof ownerConnection>;
  let companyA: string;
  let companyB: string;

  beforeAll(async () => {
    await setupTestDatabase();
    owner = ownerConnection();

    const [a] = await owner`insert into companies (workos_org_id, name, industry)
      values ('org_id_a', 'Alfa', 'retail') returning id`;
    const [b] = await owner`insert into companies (workos_org_id, name, industry)
      values ('org_id_b', 'Beta', 'retail') returning id`;
    companyA = a!.id;
    companyB = b!.id;

    // multi: pertenece a DOS empresas — el caso que existe el org-switcher para servir.
    const [multi] = await owner`insert into users (workos_user_id, email)
      values ('wos_multi', 'multi@test.local') returning id`;
    await owner`insert into company_users (company_id, user_id, role)
      values (${companyA}, ${multi!.id}, 'owner'), (${companyB}, ${multi!.id}, 'member')`;

    // solo: pertenece a UNA, y no debe ver las membresías de multi.
    const [solo] = await owner`insert into users (workos_user_id, email)
      values ('wos_solo', 'solo@test.local') returning id`;
    await owner`insert into company_users (company_id, user_id, role)
      values (${companyA}, ${solo!.id}, 'member')`;
  });

  afterAll(async () => {
    await owner?.end();
  });

  test('/me/memberships devuelve las DOS empresas del usuario', async () => {
    // El bug: con el pool sin GUC esto devolvía [] y el org-switcher salía vacío.
    const res = await request('/me/memberships', { authorization: 'Bearer wos_multi' });
    expect(res.status).toBe(200);

    const body = (await res.json()) as { memberships: { companyName: string; role: string }[] };
    expect(body.memberships.map((m) => m.companyName).sort()).toEqual(['Alfa', 'Beta']);
    expect(body.memberships.find((m) => m.companyName === 'Alfa')!.role).toBe('owner');
  });

  test('y solo las suyas: no filtra las de otro usuario de la misma empresa', async () => {
    const res = await request('/me/memberships', { authorization: 'Bearer wos_solo' });
    const body = (await res.json()) as { memberships: unknown[] };
    expect(body.memberships.length).toBe(1);
  });

  test('dos requests seguidas funcionan igual (el GUC revertido no rompe la segunda)', async () => {
    for (let i = 0; i < 3; i++) {
      const res = await request('/me/memberships', { authorization: 'Bearer wos_multi' });
      expect(res.status).toBe(200);
    }
  });

  test('el INSERT del registro pasa RLS con app.user_id, y falla sin él', async () => {
    // Las dos mitades del hallazgo en una: el mismo INSERT, con y sin GUC. Es lo que
    // rompía `/register` a mitad de camino dejando empresas huérfanas.
    const [u] = await owner`insert into users (workos_user_id, email)
      values ('wos_reg', 'reg@test.local') returning id`;
    const userId = u!.id;

    const postgres = (await import('postgres')).default;
    const appSql = postgres(testAppUrl, { max: 1, onnotice: () => {} });
    try {
      const sinGuc = await appSql
        .begin(
          (tx) => tx`insert into company_users (company_id, user_id, role)
                     values (${companyB}, ${userId}, 'owner')`,
        )
        .then(() => null)
        .catch((err: { code?: string }) => err.code);
      expect(sinGuc).toBe('42501'); // insufficient_privilege — la política rechaza el WITH CHECK

      const conGuc = await appSql.begin(async (tx) => {
        await tx`select set_config('app.user_id', ${userId}, true)`;
        return tx`insert into company_users (company_id, user_id, role)
                  values (${companyB}, ${userId}, 'owner') returning user_id`;
      });
      expect((conGuc as unknown as { user_id: string }[])[0]!.user_id).toBe(userId);
    } finally {
      await appSql.end();
    }
  });

  test('el webhook puede escribir payments con withCompanyScope', async () => {
    // El otro flujo sin usuario: la empresa sale del metadata del evento ya verificado
    // por firma, y `withCompanyScope` la traduce al GUC. Sin eso, el INSERT en
    // `payments` fallaba y los pagos no se conciliaban nunca.
    const { withCompanyScope } = await import('@/lib/db-scope');
    const { payments } = await import('@/db/schema');

    const eventId = `evt_${randomUUID()}`;
    await withCompanyScope(companyA, async (db) => {
      await db.insert(payments).values({
        companyId: companyA,
        kind: 'credit_topup',
        providerEventId: eventId,
        status: 'succeeded',
        amountUsdCents: 1000,
      });
    });

    const [row] = await owner`select company_id from payments where provider_event_id = ${eventId}`;
    expect(row!.company_id).toBe(companyA);
  });

  test('la idempotencia del webhook sobrevive al scoping', async () => {
    // onConflictDoNothing sobre provider_event_id es la garantía real de idempotencia
    // (criterio 1 de CU-868kfvaed). Meterlo dentro de una transacción por empresa no
    // debe cambiarlo: el segundo evento igual no inserta nada.
    const { withCompanyScope } = await import('@/lib/db-scope');
    const { payments } = await import('@/db/schema');

    const eventId = `evt_${randomUUID()}`;
    const insertOnce = () =>
      withCompanyScope(companyA, async (db) =>
        db
          .insert(payments)
          .values({
            companyId: companyA,
            kind: 'subscription_charge',
            providerEventId: eventId,
            status: 'succeeded',
            amountUsdCents: 500,
          })
          .onConflictDoNothing({ target: payments.providerEventId })
          .returning(),
      );

    expect((await insertOnce()).length).toBe(1);
    expect((await insertOnce()).length).toBe(0);

    const [count] = await owner`
      select count(*)::int as count from payments where provider_event_id = ${eventId}`;
    expect(count!.count).toBe(1);
  });
});
