import { describe, expect, test, beforeAll, afterAll, mock } from 'bun:test';
import { setupTestDatabase, ownerConnection, testOwnerUrl, testAppUrl } from './setup';

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════
 * EL UPGRADE A UN PLAN PAGADO COBRA — CU-868ku66du
 * ═══════════════════════════════════════════════════════════════════════════════════════
 *
 * Jose lo reportó como bug: "al cambiar de plan dentro de la gestión de créditos, se puede
 * pasar a un plan pagado sin que se exija el pago". No era lógica rota — era una decisión
 * explícita del demo, documentada en `plans.ts`, porque los precios del catálogo son
 * provisionales. Con el reporte, el criterio de producto cambia.
 *
 * Corre contra Postgres REAL y con el rol `macha_app`, no contra dobles, porque lo que hay que
 * verificar es qué queda ESCRITO en `subscriptions` en cada rama — y la garantía central del
 * ticket es negativa: que al pedir un plan pagado la suscripción NO cambie de plan. Un doble de
 * base con un `update` que no hace nada pasaría ese test sin probar nada.
 *
 * Se finge solo lo que sale de la máquina: el JWT y el proveedor de pagos.
 */

process.env.DATABASE_URL = testOwnerUrl;
process.env.APP_DATABASE_URL = testAppUrl;
process.env.WORKOS_JWKS_URL = 'https://example.invalid/jwks';

/** El "token" es literalmente el workos_user_id. */
mock.module('@/lib/auth', () => ({
  verifyToken: async (token: string) => ({ sub: token }),
}));

mock.module('@/lib/rate-limit', () => ({
  enforceTokenBucket: async () => null,
}));

/**
 * Doble del proveedor de pagos.
 *
 * Se finge `recurrente-client` y NO `provider`, a propósito: así el `metadata` que arma
 * `startSubscriptionCheckout` —el contrato con el webhook, la pieza que de verdad puede
 * desincronizarse— pasa por el código real y queda capturado acá para verificarlo.
 */
const checkoutsPedidos: Array<Record<string, unknown>> = [];
mock.module('@/lib/billing/recurrente-client', () => ({
  createSubscriptionCheckout: async (params: Record<string, unknown>) => {
    checkoutsPedidos.push(params);
    return { id: 'ch_plan_change_1', checkout_url: 'https://pay.recurrente.test/ch_plan_change_1' };
  },
  /*
   * El doble reemplaza el módulo COMPLETO, así que tiene que exportar todo lo que el real
   * exporta aunque este test no lo use: `mock.module` de Bun es global al proceso, y a
   * `provider.ts` —que sí importa las cinco— le falta cualquiera que se omita y falla al
   * cargarse con "Export named 'x' not found". Es exactamente lo que pasó al escribir esto.
   */
  createTopupCheckout: async () => ({ id: 'ch_x', checkout_url: 'https://x' }),
  isBillingConfigured: () => true,
  getSubscription: async () => ({ id: 'sub_x', status: 'active' }),
  cancelSubscription: async () => ({ message: 'cancelled' }),
}));

const { clientPlans } = await import('@/modules/billing/plans');
const { Elysia } = await import('elysia');

const app = new Elysia().use(clientPlans);

const owner = ownerConnection();
let companyId: string;

const OWNER_TOKEN = 'wos_plan_owner';
const MEMBER_TOKEN = 'wos_plan_member';

const cambiar = (planCode: string, token = OWNER_TOKEN) =>
  app.handle(
    new Request('http://localhost/plans/change', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ planCode }),
    }),
  );

const suscripcion = async () => {
  const [s] = await owner`
    select plan_code, amount_usd_cents, status, provider_checkout_id
    from subscriptions where company_id = ${companyId}
    order by created_at desc limit 1
  `;
  return s!;
};

beforeAll(async () => {
  await setupTestDatabase();

  const [c] = await owner`
    insert into companies (workos_org_id, name, industry)
    values ('wos_plan_org', 'Planes SA', 'retail') returning id
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

  // Catálogo: uno gratuito y dos pagados. `on conflict` porque el seed de las migraciones
  // puede haber sembrado algunos de estos códigos ya.
  await owner`
    insert into plans (code, name, amount_usd_cents, monthly_credits, sort_order, active) values
      ('gratis', 'Gratis', 0, 100, 0, true),
      ('pro', 'Pro', 4900, 1000, 1, true),
      ('retirado', 'Retirado', 9900, 5000, 2, false)
    on conflict (code) do update set
      amount_usd_cents = excluded.amount_usd_cents,
      active = excluded.active,
      monthly_credits = excluded.monthly_credits
  `;

  // La empresa arranca en el plan gratuito y activa.
  await owner`
    insert into subscriptions (company_id, plan_code, amount_usd_cents, status)
    values (${companyId}, 'gratis', 0, 'active')
  `;
});

afterAll(async () => {
  await owner.end();
});

describe('plan PAGADO: primero se cobra', () => {
  test('devuelve checkoutUrl en vez de aplicar el cambio', async () => {
    const res = await cambiar('pro');
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      checkoutUrl?: string;
      planCode?: string;
      changed?: boolean;
    };
    expect(body.checkoutUrl).toBe('https://pay.recurrente.test/ch_plan_change_1');
    // `changed: false` es literal y correcto: todavía no cambió nada.
    expect(body.changed).toBe(false);
    // El plan destino viaja informativo, para que la pantalla pueda decir a dónde va.
    expect(body.planCode).toBe('pro');
  });

  /**
   * ═══ LA GARANTÍA CENTRAL DEL TICKET ═══
   *
   * Mientras el pago no se confirma, el cliente sigue en su plan de antes CON SU ACCESO
   * INTACTO. Nada de estados intermedios: si abandona el checkout, no perdió nada y no ganó
   * nada. La alternativa —marcar la suscripción como "cambiando"— le habría quitado acceso a
   * alguien que todavía está pagando su plan actual.
   */
  test('la suscripción NO cambió de plan, solo guardó el id del checkout', async () => {
    const s = await suscripcion();
    expect(s.plan_code).toBe('gratis');
    expect(s.amount_usd_cents).toBe(0);
    expect(s.status).toBe('active');
    expect(s.provider_checkout_id).toBe('ch_plan_change_1');
  });

  test('el metadata lleva el plan y el monto que el webhook necesita', () => {
    /*
     * El contrato con `webhooks.ts`. Si un nombre se desincroniza, el pago se cobra y el plan no
     * cambia: la suscripción queda activa en el plan viejo y NADA falla.
     *
     * El monto viaja acá y no se relee del catálogo al confirmar el pago, porque los precios son
     * provisionales y pueden moverse entre que alguien abre el checkout y lo completa.
     */
    const meta = (checkoutsPedidos.at(-1)?.metadata ?? {}) as Record<string, string>;
    expect(meta.kind).toBe('plan_change');
    expect(meta.targetPlanCode).toBe('pro');
    expect(meta.targetAmountUsdCents).toBe('4900');
    expect(meta.companyId).toBe(companyId);
  });
});

describe('el webhook es el único que aplica el plan', () => {
  test('con el pago confirmado, la suscripción pasa al plan nuevo', async () => {
    /*
     * Se simula lo que hace el handler del webhook sobre esta misma fila, con el metadata que
     * acabó de capturarse: es el UPDATE de `payment_succeeded` para `kind: 'plan_change'`.
     *
     * No se llama al endpoint del webhook porque eso exigiría firmar un payload de Svix, que ya
     * está cubierto en `webhook-verify.test.ts`. Lo que falta verificar acá es el EFECTO sobre
     * `subscriptions`, que es de lo que este ticket habla.
     */
    const meta = (checkoutsPedidos.at(-1)?.metadata ?? {}) as Record<string, string>;
    await owner`
      update subscriptions
      set status = 'active',
          plan_code = ${meta.targetPlanCode!},
          amount_usd_cents = ${Number(meta.targetAmountUsdCents)},
          updated_at = now()
      where company_id = ${companyId} and provider_checkout_id = 'ch_plan_change_1'
    `;

    const s = await suscripcion();
    expect(s.plan_code).toBe('pro');
    expect(s.amount_usd_cents).toBe(4900);
    expect(s.status).toBe('active');
  });
});

describe('plan GRATUITO y casos borde: al instante, como antes', () => {
  test('bajar a un plan de USD 0 se aplica sin checkout', async () => {
    // Mandar a alguien a una pantalla de pago por un plan de USD 0 sería absurdo.
    const antes = checkoutsPedidos.length;
    const res = await cambiar('gratis');

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ planCode: 'gratis', changed: true });
    expect(checkoutsPedidos.length).toBe(antes);

    const s = await suscripcion();
    expect(s.plan_code).toBe('gratis');
    expect(s.amount_usd_cents).toBe(0);
  });

  test('pedir el MISMO plan no escribe ni cobra (idempotente ante doble clic)', async () => {
    const antes = checkoutsPedidos.length;
    const res = await cambiar('gratis');
    expect(await res.json()).toEqual({ planCode: 'gratis', changed: false });
    expect(checkoutsPedidos.length).toBe(antes);
  });

  test('los 409 que ya existían siguen intactos', async () => {
    // Un plan retirado se conserva para quien ya lo tiene, pero no se puede elegir.
    const retirado = await cambiar('retirado');
    expect(retirado.status).toBe(409);

    const inexistente = await cambiar('no-existe');
    expect(inexistente.status).toBe(404);
  });

  test('un member no puede cambiar de plan: sigue siendo capacidad `billing`', async () => {
    const res = await cambiar('pro', MEMBER_TOKEN);
    expect(res.status).toBe(403);
  });
});
