import { Elysia, t } from 'elysia';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { identityDerive } from '@/guards/identity.derive';
import { db } from '@/db/client';
import { companies, companyUsers, subscriptions } from '@/db/schema';
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
 */
export const register = new Elysia({ prefix: '/register' }).use(identityDerive).post(
  '/',
  async ({ userId, body }) => {
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

    await db.insert(companyUsers).values({
      companyId: company!.id,
      userId,
      role: 'owner',
      status: 'active',
    });

    await provisionTenantPartitions(company!.id);
    await seedDefaultAlertRules(db, company!.id);

    const [subscription] = await db
      .insert(subscriptions)
      .values({
        companyId: company!.id,
        planCode: 'base',
        amountUsdCents: BASE_PLAN_AMOUNT_USD_CENTS,
        status: 'pending_checkout',
      })
      .returning();

    const checkout = await startSubscriptionCheckout({
      amountUsdCents: BASE_PLAN_AMOUNT_USD_CENTS,
      companyId: company!.id,
      successUrl: `${appBaseUrl}/?registered=1`,
      cancelUrl: `${appBaseUrl}/register?cancelled=1`,
    });

    await db
      .update(subscriptions)
      .set({ providerCheckoutId: checkout.providerCheckoutId })
      .where(eq(subscriptions.id, subscription!.id));

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
