import { describe, expect, test } from 'bun:test';

process.env.DATABASE_URL ??= 'postgres://smoke:smoke@localhost:5432/smoke';

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════
 * EL UPGRADE A UN PLAN PAGADO COBRA — CU-868ku66du
 * ═══════════════════════════════════════════════════════════════════════════════════════
 *
 * Jose lo reportó como bug: "se puede pasar a un plan pagado sin que se exija el pago". No era
 * lógica rota — era una decisión explícita del demo, documentada en `plans.ts`, porque los
 * precios del catálogo son provisionales y cobrar contra un precio provisional deja cargos
 * reales que hay que reembolsar a mano. Con el reporte, el criterio de producto cambia.
 *
 * Lo que se prueba acá es el CONTRATO del metadata, que es la pieza frágil: el plan destino
 * viaja por Recurrente y vuelve en el webhook, así que si esos nombres de campo se
 * desincronizan el pago se cobra y el plan no cambia — sin que nada falle. Es el modo de fallo
 * que más caro sale y el único que un test puede fijar sin un Postgres y un proveedor de pagos
 * de verdad (eso lo cubre `tests/integration`).
 */

/*
 * `env` es un singleton compartido por TODO el run de `bun test`, así que se muta directo en
 * vez de confiar en el orden de import de `process.env` — mismo patrón que `provider.test.ts`
 * usa para el secreto del webhook. Sin clave, `recurrente-client` lanza
 * `BillingNotConfiguredError` antes de armar el cuerpo, que es justo lo que hay que inspeccionar.
 */
const { env } = await import('@/lib/env');
env.recurrenteSecretKey = 'sk_test_para_este_test';

const { startSubscriptionCheckout } = await import('./provider');

/**
 * Doble del cliente de Recurrente. Se intercepta `fetch` en vez de fingir el módulo porque
 * `mock.module` en Bun es GLOBAL al proceso: fingir `recurrente-client` desde acá rompería
 * cualquier otro test del run que lo importe de verdad.
 */
function capturarCheckout(): {
  restaurar: () => void;
  ultimoCuerpo: () => Record<string, unknown> | null;
} {
  const original = globalThis.fetch;
  let cuerpo: Record<string, unknown> | null = null;

  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    cuerpo = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
    return new Response(
      JSON.stringify({ id: 'ch_test_1', checkout_url: 'https://pay.recurrente.test/ch_test_1' }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }) as typeof fetch;

  return { restaurar: () => (globalThis.fetch = original), ultimoCuerpo: () => cuerpo };
}

/**
 * El metadata que Recurrente recibe va dentro de `items[0]`, no en la raíz del cuerpo —así lo
 * arma `recurrente-client.ts`, y es de donde el webhook lo lee de vuelta. Se extrae con un
 * helper para que el test hable del CONTRATO y no de la forma del payload del proveedor.
 */
function metadataDelCheckout(cuerpo: Record<string, unknown> | null): Record<string, string> {
  const items = (cuerpo?.items ?? []) as Array<{ metadata?: Record<string, string> }>;
  return items[0]?.metadata ?? {};
}

describe('el metadata que viaja al proveedor', () => {
  test('un CAMBIO de plan manda kind=plan_change con el plan y el monto destino', async () => {
    const cap = capturarCheckout();
    try {
      await startSubscriptionCheckout({
        amountUsdCents: 4900,
        companyId: 'comp-1',
        planName: 'Pro',
        targetPlanCode: 'pro',
        successUrl: 'https://app.macha.finance/credits?planChanged=1',
        cancelUrl: 'https://app.macha.finance/credits?cancelled=1',
      });

      const meta = metadataDelCheckout(cap.ultimoCuerpo());
      /*
       * Estos tres nombres son un CONTRATO con `webhooks.ts`. Si alguien renombra uno acá y no
       * allá, el pago se cobra y el plan no cambia: la suscripción queda `active` en el plan
       * viejo y nada falla. Por eso se fijan por nombre exacto.
       */
      expect(meta.kind).toBe('plan_change');
      expect(meta.targetPlanCode).toBe('pro');
      expect(meta.targetAmountUsdCents).toBe('4900');
      expect(meta.companyId).toBe('comp-1');
    } finally {
      cap.restaurar();
    }
  });

  test('el monto del metadata es el del checkout, no el del catálogo', async () => {
    /*
     * Los precios del catálogo son provisionales y pueden moverse entre que alguien abre el
     * checkout y lo completa. Si el webhook releyera el precio al confirmar el pago, escribiría
     * en la suscripción un monto distinto del que el cliente aceptó pagar.
     *
     * Se verifica por COMPORTAMIENTO: dos checkouts con montos distintos tienen que llevar cada
     * uno el suyo en el metadata.
     */
    const cap = capturarCheckout();
    try {
      const montos = [4900, 9900];
      const vistos: string[] = [];
      for (const amountUsdCents of montos) {
        await startSubscriptionCheckout({
          amountUsdCents,
          companyId: 'comp-1',
          targetPlanCode: 'pro',
          successUrl: 'https://app.macha.finance/x',
          cancelUrl: 'https://app.macha.finance/y',
        });
        vistos.push(metadataDelCheckout(cap.ultimoCuerpo()).targetAmountUsdCents!);
      }
      expect(vistos).toEqual(['4900', '9900']);
    } finally {
      cap.restaurar();
    }
  });

  test('el ALTA de empresa sigue mandando kind=subscription, sin tocar nada', async () => {
    // Sin `targetPlanCode` el metadata es exactamente el de antes: esta ruta no cambia de
    // comportamiento y el alta de una empresa nueva no puede convertirse en un cambio de plan.
    const cap = capturarCheckout();
    try {
      await startSubscriptionCheckout({
        amountUsdCents: 2900,
        companyId: 'comp-2',
        successUrl: 'https://app.macha.finance/x',
        cancelUrl: 'https://app.macha.finance/y',
      });
      const meta = metadataDelCheckout(cap.ultimoCuerpo());
      expect(meta.kind).toBe('subscription');
      expect(meta.targetPlanCode).toBeUndefined();
      expect(Object.keys(meta).sort()).toEqual(['companyId', 'kind']);
    } finally {
      cap.restaurar();
    }
  });
});

/*
 * ═══ LO QUE NO SE PRUEBA ACÁ, Y DÓNDE SÍ ═══
 *
 * El comportamiento del handler —que un plan pagado devuelva `checkoutUrl` sin tocar la
 * suscripción, que un gratuito se aplique al instante, y que el webhook aplique el plan al
 * confirmarse el pago— se prueba con Postgres de verdad en
 * `tests/integration/plan-change-checkout.test.ts`.
 *
 * La primera versión de este archivo lo verificaba leyendo `plans.ts` como texto y buscando
 * cadenas. Eso falló de inmediato por la razón correcta: `planCode: destino.code` aparece en el
 * `return` (informativo, para que el frontend sepa a qué plan se va) además del UPDATE, así que
 * la búsqueda daba un falso positivo. Un test que se rompe cuando el código se reordena sin
 * cambiar de comportamiento no protege nada: solo obliga a mantenerlo.
 */
