import { describe, expect, test, beforeAll, afterAll, mock } from 'bun:test';
import { setupTestDatabase, ownerConnection, testOwnerUrl, testAppUrl } from './setup';

/**
 * CU-868kh8pwv, capacidad `configure_alerts`: el cliente ajusta sus propios umbrales.
 *
 * Contra Postgres real y con el rol `macha_app`, porque `alert_rules` tiene RLS por
 * empresa: lo que se prueba no es solo la matriz de permisos, es que el UPDATE del
 * cliente atraviese el backstop igual que lo hace el del backoffice.
 */

process.env.DATABASE_URL = testOwnerUrl;
process.env.APP_DATABASE_URL = testAppUrl;
process.env.WORKOS_JWKS_URL = 'https://example.invalid/jwks';

/** El "token" es literalmente el workos_user_id. */
mock.module('@/lib/auth', () => ({
  verifyToken: async (token: string) => ({ sub: token }),
}));

// No hay Redis en el job de integración y el bucket `read` no es lo que se prueba aquí.
mock.module('@/lib/rate-limit', () => ({
  enforceTokenBucket: async () => null,
}));

const { clientAlertRules } = await import('@/modules/alert-rules');
const { Elysia } = await import('elysia');

const app = new Elysia().use(clientAlertRules);

const owner = ownerConnection();
let companyId: string;

const OWNER_TOKEN = 'wos_alert_owner';
const MEMBER_TOKEN = 'wos_alert_member';

const call = (path: string, token: string, init?: RequestInit) =>
  app.handle(
    new Request(`http://localhost/alert-rules${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        ...(init?.headers ?? {}),
      },
    }),
  );

beforeAll(async () => {
  await setupTestDatabase();

  const [c] = await owner`
    insert into companies (workos_org_id, name, industry)
    values ('wos_alert_org', 'Alertas SA', 'retail') returning id
  `;
  companyId = c!.id;

  for (const [token, role] of [
    [OWNER_TOKEN, 'owner'],
    [MEMBER_TOKEN, 'member'],
  ] as const) {
    const [u] = await owner`
      insert into users (workos_user_id, email)
      values (${token}, ${`${token}@test.local`}) returning id
    `;
    await owner`
      insert into company_users (company_id, user_id, role, status)
      values (${companyId}, ${u!.id}, ${role}, 'active')
    `;
  }

  // Las mismas 6 reglas que siembra `seedDefaultAlertRules` en el alta.
  await owner`
    insert into alert_rules (company_id, rule_key, threshold, notify_immediately) values
      (${companyId}, 'ar_overdue', 60, true),
      (${companyId}, 'portfolio_concentration', 25, true),
      (${companyId}, 'revenue_drop', 15, true),
      (${companyId}, 'margin_drop', 25, false),
      (${companyId}, 'spend_out_of_range', 40, false),
      (${companyId}, 'low_credit_balance', 20, false)
  `;
});

afterAll(async () => {
  await owner.end();
});

describe('configure_alerts del lado del cliente', () => {
  test('el owner ve sus reglas con etiqueta y unidad', async () => {
    const res = await call('/', OWNER_TOKEN);
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      rules: Array<{ ruleKey: string; unit: string | null; threshold: number }>;
    };
    expect(body.rules).toHaveLength(6);

    const arOverdue = body.rules.find((r) => r.ruleKey === 'ar_overdue');
    // La unidad es el dato que hace legible el umbral: sin ella un "60" no dice si son
    // días o por ciento.
    expect(arOverdue).toMatchObject({ unit: 'days', threshold: 60 });
  });

  test('un member NO puede configurar alertas (matriz de Jose: owner/admin)', async () => {
    expect((await call('/', MEMBER_TOKEN)).status).toBe(403);
    expect(
      (
        await call('/ar_overdue', MEMBER_TOKEN, {
          method: 'PATCH',
          body: JSON.stringify({ threshold: 90 }),
        })
      ).status,
    ).toBe(403);
  });

  test('el owner sube su umbral de cartera vencida de 60 a 90 días', async () => {
    const res = await call('/ar_overdue', OWNER_TOKEN, {
      method: 'PATCH',
      body: JSON.stringify({ threshold: 90 }),
    });
    expect(res.status).toBe(200);

    // Se comprueba en la base, no en la respuesta: es el mismo dato que edita el
    // backoffice, no una copia.
    const [row] = await owner`
      select threshold from alert_rules
      where company_id = ${companyId} and rule_key = 'ar_overdue'
    `;
    expect(Number(row!.threshold)).toBe(90);
  });

  test('un porcentaje fuera de 0-100 se rechaza', async () => {
    const res = await call('/margin_drop', OWNER_TOKEN, {
      method: 'PATCH',
      body: JSON.stringify({ threshold: 150 }),
    });
    expect(res.status).toBe(422);

    const [row] = await owner`
      select threshold from alert_rules
      where company_id = ${companyId} and rule_key = 'margin_drop'
    `;
    expect(Number(row!.threshold)).toBe(25); // intacto
  });

  test('un umbral en días fraccionario se rechaza', async () => {
    const res = await call('/ar_overdue', OWNER_TOKEN, {
      method: 'PATCH',
      body: JSON.stringify({ threshold: 1.5 }),
    });
    expect(res.status).toBe(422);
  });

  test('una regla fuera del catálogo no se puede crear ni tocar', async () => {
    const res = await call('/regla_inventada', OWNER_TOKEN, {
      method: 'PATCH',
      body: JSON.stringify({ threshold: 10 }),
    });
    expect(res.status).toBe(404);
  });

  /**
   * Cuáles son las tres reglas de "dato crítico" es decisión de producto (CU-868kfv993),
   * no preferencia por empresa: si el cliente pudiera activarlas todas, acabaría
   * ignorando los correos, que es justo lo que esa decisión evita.
   */
  test('el cliente no puede convertir una regla en correo inmediato', async () => {
    await call('/margin_drop', OWNER_TOKEN, {
      method: 'PATCH',
      body: JSON.stringify({ notifyImmediately: true, enabled: true }),
    });

    const [row] = await owner`
      select notify_immediately from alert_rules
      where company_id = ${companyId} and rule_key = 'margin_drop'
    `;
    expect(row!.notify_immediately).toBe(false);
  });

  test('el owner puede apagar una regla', async () => {
    const res = await call('/low_credit_balance', OWNER_TOKEN, {
      method: 'PATCH',
      body: JSON.stringify({ enabled: false }),
    });
    expect(res.status).toBe(200);

    const [row] = await owner`
      select enabled from alert_rules
      where company_id = ${companyId} and rule_key = 'low_credit_balance'
    `;
    expect(row!.enabled).toBe(false);
  });
});
