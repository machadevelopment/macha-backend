import { Elysia, t } from 'elysia';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { identityDerive } from '@/guards/identity.derive';
import { enforceTokenBucketForUser } from '@/lib/rate-limit';
import { companies, companyUsers, subscriptions, users } from '@/db/schema';
import { provisionTenantPartitions } from '@/lib/tenant-provisioning';
import { seedDefaultAlertRules } from '@/lib/alert-rules-seed';
import { grantInitialCredits } from '@/lib/credits';
import {
  startSubscriptionCheckout,
  BASE_PLAN_AMOUNT_USD_CENTS,
  appBaseUrl,
} from '@/lib/billing/provider';
import { isBillingConfigured } from '@/lib/billing/recurrente-client';
import { BillingNotConfiguredError } from '@/lib/billing/billing-errors';
import { env } from '@/lib/env';

/**
 * CU-868kfvae1/868kfvaem: registro autoservicio — alta automática de empresa+owner
 * sin intervención del admin (criterio 2 de ambos tickets). Usa identityDerive (F2),
 * no tenantDerive: el usuario ya inició sesión por WorkOS pero todavía no tiene
 * ninguna empresa — es literalmente lo que este endpoint crea.
 *
 * CU-868kjc4wa — DOS COSAS CAMBIARON AQUÍ.
 *
 * 1. **Scoping.** Se escribía con el pool global sin ningún GUC. Bajo el rol macha_app
 *    el INSERT en `company_users` lanza `new row violates row-level security policy`
 *    (la política de 0002/0012 es FOR ALL, así que su USING también sirve de WITH CHECK
 *    para el INSERT). Ahora se usa el `db` de identityDerive, que ya lleva
 *    `app.user_id`; y en cuanto existe la empresa se llama a `scopeToCompany` para que
 *    `subscriptions` y `alert_rules` —que filtran por `app.company_id`— también pasen.
 *
 * 2. **Atomicidad.** No la había: cada paso era autónomo, así que un fallo a mitad
 *    dejaba una empresa sin usuario ni suscripción, y cada reintento del usuario creaba
 *    otra empresa fantasma. Ahora todo corre dentro de la transacción del request
 *    (identityDerive la abre y la cierra en los hooks), así que un throw revierte el
 *    alta completa.
 *
 * El orden importa y no es el que era:
 *   - el checkout con Recurrente ocurre ANTES de insertar la suscripción, para que la
 *     fila nazca con `provider_checkout_id` y desaparezca el UPDATE posterior;
 *   - las particiones se crean PRIMERO, antes del INSERT en `companies`.
 *
 * Ese último punto estaba invertido y colgaba la petición para siempre. Las particiones
 * se creaban al final para no dejar huérfanas si algo fallaba antes — razonable sobre el
 * papel, imposible en la práctica: el DDL corre sobre otra conexión (rol dueño) y
 * `CREATE TABLE ... PARTITION OF transactions` hereda la FK compuesta a `companies`,
 * cuya validación pide un ShareRowExclusiveLock sobre `companies`. Ese lock choca con el
 * RowExclusiveLock que dejó el INSERT de ESTA transacción, que no cierra hasta
 * `onAfterHandle` — o sea, hasta después de este handler. El DDL espera al request y el
 * request espera al DDL. Postgres no lo mata: su detector solo ve ciclos entre locks, y
 * el request no espera un lock sino al cliente (`idle in transaction`).
 *
 * Verificado en producción sobre el gemelo de este código (`POST /admin/companies`, la
 * otra vía por la que nace una empresa): petición colgada indefinidamente y
 * `pg_blocking_pids` confirmando el ciclo.
 *
 * Coste asumido del orden nuevo: si algo falla después, quedan particiones vacías de una
 * empresa que no existe. Es basura inocua —tablas vacías— y `CREATE TABLE IF NOT EXISTS`
 * hace idempotente el reintento; colgar el alta de empresas no tiene arreglo desde fuera.
 *
 * Queda un caso extremo asumido: si el commit falla DESPUÉS del checkout, queda un
 * checkout abierto en Recurrente sin empresa local. El webhook lo ignoraría (no
 * encontraría la suscripción) y el cobro no llegaría a activarse.
 */
export const register = new Elysia({ prefix: '/register' }).use(identityDerive).post(
  '/',
  async ({ userId, body, set, db, scopeToCompany }) => {
    // CU-868kjc950 criterio 1: por USUARIO, porque aquí todavía no hay empresa. Cada
    // llamada corre `CREATE TABLE ... PARTITION OF` tres veces contra el Postgres
    // compartido: sin techo, esto es DDL ilimitado sobre la base de todos los clientes.
    const limited = await enforceTokenBucketForUser('register', userId, set, 'POST /register');
    if (limited) return limited;

    // Antes del INSERT: ver la nota de arriba sobre el abrazo mortal.
    const companyId = randomUUID();
    await provisionTenantPartitions(companyId);

    const [company] = await db
      .insert(companies)
      .values({
        id: companyId,
        // Sin org de WorkOS propia todavía para una empresa auto-registrada (eso
        // vive en el flujo de invite/multi-tenant de WorkOS, fuera de alcance aquí)
        // — placeholder estable y único por empresa.
        workosOrgId: `self_serve_${randomUUID()}`,
        name: body.name,
        industry: body.industry,
        baseCurrency: body.baseCurrency,
        locale: body.locale,
      })
      .returning();

    // Desde aquí las escrituras por empresa pasan la política de RLS. `companies` no
    // tiene RLS, por eso el INSERT de arriba funciona antes de este SET LOCAL.
    await scopeToCompany(company!.id);

    await db.insert(companyUsers).values({
      companyId: company!.id,
      userId,
      role: 'owner',
      status: 'active',
    });

    // CU-868kjkfdf criterio 3: el alta JIT de `users` deja `locale` en el default 'es'
    // porque WorkOS no expone preferencia de idioma. Este es el primer momento en que el
    // idioma se SABE —el usuario acaba de elegirlo para su empresa— así que se sincroniza
    // aquí. De esto dependen los emails de reporte y alerta, que se mandan por
    // `users.locale`, no por el de la empresa.
    await db.update(users).set({ locale: body.locale }).where(eq(users.id, userId));

    await seedDefaultAlertRules(db, company!.id);

    // CU-868kjc7g5 criterio 3: la empresa nace con saldo. Antes terminaba el registro en
    // 0 y su primer insight devolvía 402 — el checkout de Recurrente era el ÚNICO camino
    // para tener créditos, cuando el PRD trata la compra self-serve como algo que se
    // suma al plan, no como la puerta de entrada. Va dentro de la transacción del
    // request: una empresa a medio crear no debe quedar con créditos.
    await grantInitialCredits(db, company!.id);

    // CU-868kmxu41 — EL CHECKOUT SE DECIDE, NO SE ASUME.
    //
    // Antes esto llamaba a Recurrente sin más, y en un entorno sin
    // `RECURRENTE_SECRET_KEY` el throw tumbaba el registro entero con un 500 cuyo texto
    // interno llegaba literal al navegador. Efecto real en producción: NINGUNA empresa
    // podía darse de alta, así que ningún piloto podía entrar a probar el producto.
    //
    // Ahora hay dos caminos y ambos son explícitos:
    //
    //  · Con proveedor configurado -> lo de siempre: checkout primero, y la suscripción
    //    nace ya con su `provider_checkout_id`.
    //  · Sin proveedor -> depende de `BILLING_CHECKOUT_OPTIONAL`. Si está encendida, la
    //    empresa se crea y su suscripción queda en `pending_checkout` sin id de
    //    checkout: es el estado honesto —existe, no ha pagado— y el cobro se puede
    //    reconciliar después. Si NO está encendida, se rechaza con un 503 limpio.
    //
    // El opt-in es deliberado: si la simple ausencia de la clave bastara para saltarse
    // el cobro, olvidar la variable en producción regalaría cuentas en silencio.
    if (!isBillingConfigured() && !env.billingCheckoutOptional) {
      throw new BillingNotConfiguredError();
    }

    const checkout = isBillingConfigured()
      ? await startSubscriptionCheckout({
          amountUsdCents: BASE_PLAN_AMOUNT_USD_CENTS,
          companyId: company!.id,
          successUrl: `${appBaseUrl}/?registered=1`,
          cancelUrl: `${appBaseUrl}/register?cancelled=1`,
        })
      : null;

    await db.insert(subscriptions).values({
      companyId: company!.id,
      planCode: 'base',
      amountUsdCents: BASE_PLAN_AMOUNT_USD_CENTS,
      status: 'pending_checkout',
      providerCheckoutId: checkout?.providerCheckoutId,
    });

    // `checkoutUrl: null` le dice al frontend "entrá a la app" en vez de redirigir a un
    // checkout que no existe. No se devuelve una cadena vacía: un `null` explícito es
    // imposible de confundir con una URL rota.
    return { companyId: company!.id, checkoutUrl: checkout?.checkoutUrl ?? null };
  },
  {
    body: t.Object({
      name: t.String(),
      industry: t.String(),
      baseCurrency: t.Union([t.Literal('GTQ'), t.Literal('USD')]),
      locale: t.Union([t.Literal('es'), t.Literal('en')]),
    }),
  },
);
