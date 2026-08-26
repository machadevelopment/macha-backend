import { describe, expect, test, beforeAll, afterAll, mock } from 'bun:test';
import { Elysia } from 'elysia';
import { setupTestDatabase, ownerConnection, testOwnerUrl, testAppUrl } from './setup';

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * EL CATÁLOGO DE INDUSTRIAS TIENE QUE RESPONDERLE A QUIEN TODAVÍA NO TIENE EMPRESA
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *
 * `GET /industry-templates/industries` existe para que la pantalla de registro ofrezca un
 * desplegable en vez de un campo de texto libre. Nació montada sobre `tenantDerive`, que corta
 * con 403 cuando no hay membresía — o sea que le fallaba EXACTAMENTE al usuario para el que se
 * construyó: el que está creando su primera empresa.
 *
 * ═══ POR QUÉ NO LO ATRAPÓ NADA ═══
 *
 * `app.test.ts` ya comprobaba la ruta, pero con la pregunta "¿devuelve 401 sin token?", y esa
 * la contestan igual los DOS guards. El test pasaba en verde mientras la funcionalidad estaba
 * muerta en producción.
 *
 * Y del lado del cliente tampoco se veía: el wizard cae a un campo de texto libre si la lista
 * no llega —degradación deliberada, para que un fallo de red no impida terminar el registro—
 * así que un 403 se ve igual que el formulario de siempre. Medido contra producción: 17 de 32
 * empresas tienen un `industry` que no resuelve a ningún slug, dos de ellas creadas DESPUÉS de
 * que la lista existiera.
 *
 * Por eso este test no pregunta por el código de estado sin token: monta la MISMA ruta bajo los
 * DOS guards y exige que se comporten distinto ante un usuario sin membresía. Es la única forma
 * de que una vuelta a `tenantDerive` se ponga roja.
 */

process.env.DATABASE_URL = testOwnerUrl;
process.env.APP_DATABASE_URL = testAppUrl;
process.env.WORKOS_JWKS_URL = 'https://example.invalid/jwks';

mock.module('@/lib/auth', () => ({
  verifyToken: async (token: string) => {
    if (token === 'invalid') throw new Error('bad signature');
    return { sub: token };
  },
}));

const { industryList } = await import('@/modules/industry-templates');
const { tenantDerive } = await import('@/guards/tenant.derive');
const { TARGET_INDUSTRIES } = await import('@/config/industries');

const app = new Elysia().use(industryList);

/**
 * La MISMA ruta bajo el guard que la rompía. No se importa el módulo viejo (ya no existe): se
 * reconstruye el montaje anterior, que es lo que hay que dejar demostrado como incorrecto.
 */
const appConTenant = new Elysia({ prefix: '/industry-templates' })
  .use(tenantDerive)
  .get('/industries', () => ({ industries: TARGET_INDUSTRIES }));

const pedir = (a: Elysia, token: string) =>
  a.handle(
    new Request('http://localhost/industry-templates/industries', {
      headers: { authorization: `Bearer ${token}` },
    }),
  );

describe('el catálogo de industrias del alta (2026-08-26)', () => {
  let owner: ReturnType<typeof ownerConnection>;

  beforeAll(async () => {
    await setupTestDatabase();
    owner = ownerConnection();

    // El usuario que estrena cuenta: existe en WorkOS, no pertenece a ninguna empresa.
    await owner`insert into users (workos_user_id, email)
      values ('wos_sin_empresa', 'nuevo@test.local')`;

    // Y uno que sí tiene empresa, para comprobar que el arreglo no rompe el caso que ya andaba.
    const [c] = await owner`insert into companies (workos_org_id, name, industry)
      values ('org_ind', 'Con Empresa', 'retail') returning id`;
    const [u] = await owner`insert into users (workos_user_id, email)
      values ('wos_con_empresa', 'viejo@test.local') returning id`;
    await owner`insert into company_users (company_id, user_id, role)
      values (${c!.id}, ${u!.id}, 'owner')`;
  });

  afterAll(async () => {
    await owner?.end();
  });

  test('un usuario SIN empresa recibe la lista completa', async () => {
    const res = await pedir(app, 'wos_sin_empresa');
    expect(res.status).toBe(200);

    const body = (await res.json()) as { industries: string[] };
    expect(body.industries).toEqual([...TARGET_INDUSTRIES]);
    // La lista sirve para elegir plantilla: si viniera vacía el desplegable existiría y no
    // ofrecería nada, que para el cliente es lo mismo que no estar.
    expect(body.industries.length).toBeGreaterThan(20);
  });

  test('bajo `tenantDerive` ese mismo usuario recibía 403 — el bug que esto fija', async () => {
    const res = await pedir(appConTenant, 'wos_sin_empresa');
    expect(res.status).toBe(403);
  });

  test('el usuario que YA tiene empresa la sigue recibiendo', async () => {
    const res = await pedir(app, 'wos_con_empresa');
    expect(res.status).toBe(200);
  });

  /**
   * Que un token inválido devuelva 401 y no 500 depende del `onError` de `src/app.ts`, que este
   * montaje pelado no tiene — acá el mismo rechazo sale como 500. El código exacto se
   * comprueba en `app.test.ts` contra la app completa; lo que corresponde afirmar aquí es lo
   * único que este montaje puede demostrar y es lo que de verdad importa: que sin credencial
   * válida la lista NO se entrega.
   */
  test('sin credencial válida no se entrega la lista', async () => {
    for (const res of [
      await pedir(app, 'invalid'),
      await app.handle(new Request('http://localhost/industry-templates/industries')),
    ]) {
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(await res.text()).not.toContain('nonbank_financial');
    }
  });
});
