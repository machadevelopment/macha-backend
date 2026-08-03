import { Elysia, t } from 'elysia';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { identityDerive } from '@/guards/identity.derive';
import { companies, companyUsers, subscriptions, users } from '@/db/schema';
import { provisionTenantPartitions } from '@/lib/tenant-provisioning';
import { seedDefaultAlertRules } from '@/lib/alert-rules-seed';
import {
  startSubscriptionCheckout,
  BASE_PLAN_AMOUNT_USD_CENTS,
  appBaseUrl,
} from '@/lib/billing/provider';

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
 *   - las particiones se crean AL FINAL. Son DDL sobre otra conexión (rol dueño) y no
 *     participan de esta transacción: si algo falla antes, no queda una partición
 *     huérfana de una empresa que se revirtió.
 *
 * Queda un caso extremo asumido: si el commit falla DESPUÉS del checkout, queda un
 * checkout abierto en Recurrente sin empresa local. El webhook lo ignoraría (no
 * encontraría la suscripción) y el cobro no llegaría a activarse.
 */
export const register = new Elysia({ prefix: '/register' }).use(identityDerive).post(
  '/',
  async ({ userId, body, db, scopeToCompany }) => {
    const [company] = await db
      .insert(companies)
      .values({
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

    const checkout = await startSubscriptionCheckout({
      amountUsdCents: BASE_PLAN_AMOUNT_USD_CENTS,
      companyId: company!.id,
      successUrl: `${appBaseUrl}/?registered=1`,
      cancelUrl: `${appBaseUrl}/register?cancelled=1`,
    });

    await db.insert(subscriptions).values({
      companyId: company!.id,
      planCode: 'base',
      amountUsdCents: BASE_PLAN_AMOUNT_USD_CENTS,
      status: 'pending_checkout',
      providerCheckoutId: checkout.providerCheckoutId,
    });

    await provisionTenantPartitions(company!.id);

    return { companyId: company!.id, checkoutUrl: checkout.checkoutUrl };
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
