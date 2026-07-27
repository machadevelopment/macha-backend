import { Elysia, t } from 'elysia';
import { tenantDerive } from '@/guards/tenant.derive';
import { assertClientCapability } from '@/guards/require-capability';
import { getPlatformSetting, SETTINGS_KEYS } from '@/lib/settings';
import { startTopupCheckout, appBaseUrl } from '@/lib/billing/provider';

/** CU-868kfvaet: dispara el checkout de recarga — el saldo solo se actualiza tras la conciliación del webhook (modules/billing/webhooks.ts), no aquí. */
export const creditsTopup = new Elysia({ prefix: '/credits/topup' }).use(tenantDerive).post(
  '/',
  async ({ companyId, role, body, set, db }) => {
    assertClientCapability(role, 'billing', set);

    const pricePerCredit = await getPlatformSetting(db, SETTINGS_KEYS.creditPriceUsdCents, 10);
    const amountUsdCents = pricePerCredit * body.credits;

    const checkout = await startTopupCheckout({
      amountUsdCents,
      credits: body.credits,
      companyId,
      successUrl: `${appBaseUrl}/credits?purchased=1`,
      cancelUrl: `${appBaseUrl}/credits?cancelled=1`,
    });

    return { checkoutUrl: checkout.checkoutUrl };
  },
  { body: t.Object({ credits: t.Number({ minimum: 1 }) }) },
);
