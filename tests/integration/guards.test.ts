import { describe, expect, test, beforeAll, afterAll, mock } from 'bun:test';
import { Elysia } from 'elysia';
import {
  setupTestDatabase,
  appConnection,
  ownerConnection,
  testOwnerUrl,
  testAppUrl,
} from './setup';

/**
 * CU-868kh8zbj criterio 4: `tenant.derive` y `admin.guard` con JWT falso pero
 * verificación REAL de membresías contra Postgres.
 *
 * Lo que se falsea es solo la firma del JWT (verificarla de verdad exigiría un JWKS
 * de WorkOS vivo, que no pinta nada en un test de aislamiento). Todo lo demás —
 * resolver workos_user_id → users → company_users, rechazar empresas suspendidas,
 * leer la tabla `staff`— corre contra la base real. Que es justo donde puede haber
 * una regresión de tenant-scoping.
 *
 * `mock.module` es seguro AQUÍ y no lo sería en los tests unitarios: la suite de
 * integración corre en su propia invocación de `bun test` (script `test:integration`),
 * así que el mock no puede filtrarse a los 16 archivos de `src/`.
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

const { tenantDerive } = await import('@/guards/tenant.derive');
const { adminGuard } = await import('@/guards/admin.guard');

const app = new Elysia()
  .use(tenantDerive)
  .get('/whoami', ({ companyId, role }) => ({ companyId, role }))
  .use(adminGuard)
  .get('/admin/whoami', ({ tier }) => ({ tier }));

function request(path: string, headers: Record<string, string>) {
  return app.handle(new Request(`http://localhost${path}`, { headers }));
}

describe('guards contra Postgres real (CU-868kh8zbj)', () => {
  let owner: ReturnType<typeof ownerConnection>;
  let companyA: string;
  let companyB: string;
  let suspended: string;

  beforeAll(async () => {
    await setupTestDatabase();
    owner = ownerConnection();

    const [a] = await owner`insert into companies (workos_org_id, name, industry)
      values ('org_g_a', 'A', 'retail') returning id`;
    const [b] = await owner`insert into companies (workos_org_id, name, industry)
      values ('org_g_b', 'B', 'retail') returning id`;
    const [s] = await owner`insert into companies (workos_org_id, name, industry, status)
      values ('org_g_s', 'S', 'retail', 'suspended') returning id`;
    companyA = a!.id;
    companyB = b!.id;
    suspended = s!.id;

    // miembro-de-A: pertenece solo a la empresa A.
    const [memberA] = await owner`insert into users (workos_user_id, email)
      values ('wos_member_a', 'a@test.local') returning id`;
    await owner`insert into company_users (company_id, user_id, role)
      values (${companyA}, ${memberA!.id}, 'owner')`;

    // miembro-suspendida: su única empresa está suspendida.
    const [memberS] = await owner`insert into users (workos_user_id, email)
      values ('wos_member_s', 's@test.local') returning id`;
    await owner`insert into company_users (company_id, user_id, role)
      values (${suspended}, ${memberS!.id}, 'owner')`;

    // staff-user: existe en `staff`, activo.
    const [staffUser] = await owner`insert into users (workos_user_id, email)
      values ('wos_staff', 'staff@test.local') returning id`;
    await owner`insert into staff (user_id, tier) values (${staffUser!.id}, 'super_admin')`;
    await owner`insert into company_users (company_id, user_id, role)
      values (${companyA}, ${staffUser!.id}, 'member')`;

    // huérfano: tiene identidad en WorkOS pero ninguna membresía activa.
    await owner`insert into users (workos_user_id, email)
      values ('wos_orphan', 'orphan@test.local')`;
  });

  afterAll(async () => {
    await owner?.end();
    // El pool compartido de src/db/client.ts NO se cierra aquí: bun test corre todos
    // los archivos en el mismo proceso y cerrarlo dejaba sin conexión a los que
    // corrieran después (CONNECTION_ENDED → 500). Lo cierra una sola vez el preload
    // tests/integration/teardown.ts (CU-868kjc4wa).
  });

  describe('tenant.derive', () => {
    test('resuelve company_id y rol desde company_users, no desde el cliente', async () => {
      // CU-868kj3utc: este test estuvo `.skip` mientras el guard devolvía 403 a TODO
      // request autenticado bajo el rol `macha_app`. Corre con `APP_DATABASE_URL`
      // apuntando a ese rol (ver arriba), que es la precondición del criterio 1.
      const res = await request('/whoami', { authorization: 'Bearer wos_member_a' });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ companyId: companyA, role: 'owner' });
    });

    test('CU-868kj3utc: sin ningún GUC seteado, company_users sigue sin devolver filas', async () => {
      // El arreglo NO puede consistir en "dejar leer cuando no hay scoping". El modo de
      // fallo tiene que seguir siendo ver cero filas: si una ruta nueva se saltara el
      // guard, no debe heredar acceso a la tabla que decide quién ve qué.
      const owner2 = ownerConnection();
      try {
        const [real] = await owner2`select count(*)::int as count from company_users`;
        expect(real!.count).toBeGreaterThan(0);
      } finally {
        await owner2.end();
      }

      const app2 = appConnection();
      try {
        const [visible] = await app2`select count(*)::int as count from company_users`;
        expect(visible!.count).toBe(0);
      } finally {
        await app2.end();
      }
    });

    test('CU-868kj3utc: con app.user_id, un usuario ve SUS membresías y solo esas', async () => {
      // La otra mitad de la política nueva (migración 0012): el GUC de identidad abre
      // exactamente las filas del usuario, no la tabla entera. Si abriera más, el
      // arreglo del 403 habría costado el aislamiento que 0010 vino a garantizar.
      const owner2 = ownerConnection();
      const [me] = await owner2`select id from users where workos_user_id = 'wos_member_a'`;
      const [total] = await owner2`select count(*)::int as count from company_users`;
      await owner2.end();
      expect(total!.count).toBeGreaterThan(1); // hay membresías de otros usuarios

      const app2 = appConnection();
      try {
        const rows = await app2.begin(async (tx) => {
          await tx`select set_config('app.user_id', ${me!.id}, true)`;
          return tx`select user_id from company_users`;
        });
        expect(rows.length).toBe(1);
        expect((rows as unknown as { user_id: string }[])[0]!.user_id).toBe(me!.id);
      } finally {
        await app2.end();
      }
    });

    test('CU-868kj3utc: dos requests seguidas funcionan igual que la primera', async () => {
      // El guard reserva una conexión del pool y la devuelve al terminar, con el GUC
      // `app.company_id` revertido a la cadena vacía. Con la política vieja, la
      // siguiente request que reutilizara esa conexión se caía con un 500
      // (`invalid input syntax for type uuid: ""`) — o sea, la app servía la primera
      // request de cada conexión y fallaba a partir de la segunda.
      for (let i = 0; i < 3; i++) {
        const res = await request('/whoami', { authorization: 'Bearer wos_member_a' });
        expect(res.status).toBe(200);
      }
    });

    test('rechaza sin bearer token', async () => {
      const res = await request('/whoami', {});
      expect(res.status).toBe(401);
    });

    test('rechaza un X-Company-Id de una empresa ajena', async () => {
      // EL test del ticket: el header solo puede SELECCIONAR entre las membresías
      // reales del usuario, nunca concederle una nueva.
      const res = await request('/whoami', {
        authorization: 'Bearer wos_member_a',
        'x-company-id': companyB,
      });
      expect(res.status).toBe(403);
    });

    test('rechaza a una identidad sin membresía activa', async () => {
      const res = await request('/whoami', { authorization: 'Bearer wos_orphan' });
      expect(res.status).toBe(403);
    });

    test('rechaza a un usuario de WorkOS sin cuenta en Macha', async () => {
      const res = await request('/whoami', { authorization: 'Bearer wos_desconocido' });
      expect(res.status).toBe(403);
    });

    test('rechaza si la empresa está suspendida', async () => {
      const res = await request('/whoami', { authorization: 'Bearer wos_member_s' });
      expect(res.status).toBe(403);
    });
  });

  describe('admin.guard', () => {
    // Nota: en esta app de prueba `/admin/whoami` pasa ANTES por tenantDerive (está
    // montado con `.as('global')`), así que este caso arrastraba el 403 de
    // CU-868kj3utc. En la app real el namespace admin no cuelga del guard tenant
    // (CU-868kfvaex); aquí el encadenado lo hace, si acaso, un test más exigente.
    test('acepta a un usuario presente en la tabla staff y expone su tier', async () => {
      const res = await request('/admin/whoami', { authorization: 'Bearer wos_staff' });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ tier: 'super_admin' });
    });

    test('rechaza a un no-staff aunque sea miembro legítimo de una empresa', async () => {
      // El namespace admin se gatea por `staff`, no por `company_users`: ser owner de
      // tu propia empresa no da acceso al backoffice de Macha.
      const res = await request('/admin/whoami', { authorization: 'Bearer wos_member_a' });
      expect(res.status).toBe(403);
    });

    test('rechaza sin bearer token', async () => {
      const res = await request('/admin/whoami', {});
      expect(res.status).toBe(401);
    });
  });
});
