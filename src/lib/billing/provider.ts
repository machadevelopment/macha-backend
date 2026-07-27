import {
  createSubscriptionCheckout as recurrenteCreateSubscriptionCheckout,
  createTopupCheckout as recurrenteCreateTopupCheckout,
  cancelSubscription as recurrenteCancelSubscription,
} from './recurrente-client';
import { verifyRecurrenteWebhook } from './webhook-verify';
import { env } from '@/lib/env';

/**
 * CU-868kfvae6 criterio 2: interfaz propia, no acoplada a Recurrente — el resto de
 * la app (registro, top-up de créditos, webhook handler) importa SOLO de este
 * archivo. Migrar a Stripe más adelante significa reescribir este archivo +
 * recurrente-client.ts/webhook-verify.ts, ningún otro call site cambia.
 */
export interface CheckoutResult {
  checkoutUrl: string;
  providerCheckoutId: string;
}

export async function startSubscriptionCheckout(params: {
  amountUsdCents: number;
  successUrl: string;
  cancelUrl: string;
  companyId: string;
}): Promise<CheckoutResult> {
  const checkout = await recurrenteCreateSubscriptionCheckout({
    amountUsdCents: params.amountUsdCents,
    successUrl: params.successUrl,
    cancelUrl: params.cancelUrl,
    metadata: { companyId: params.companyId, kind: 'subscription' },
  });
  return { checkoutUrl: checkout.checkout_url, providerCheckoutId: checkout.id };
}

export async function startTopupCheckout(params: {
  amountUsdCents: number;
  credits: number;
  successUrl: string;
  cancelUrl: string;
  companyId: string;
}): Promise<CheckoutResult> {
  const checkout = await recurrenteCreateTopupCheckout({
    amountUsdCents: params.amountUsdCents,
    successUrl: params.successUrl,
    cancelUrl: params.cancelUrl,
    metadata: {
      companyId: params.companyId,
      kind: 'credit_topup',
      credits: String(params.credits),
    },
  });
  return { checkoutUrl: checkout.checkout_url, providerCheckoutId: checkout.id };
}

export function cancelProviderSubscription(providerSubscriptionId: string): Promise<void> {
  return recurrenteCancelSubscription(providerSubscriptionId).then(() => undefined);
}

/**
 * Normalized shape the webhook handler (modules/billing/webhooks.ts) consumes —
 * decoupled from Recurrente's raw envelope.
 *
 * Verified against docs.recurrente.com: the envelope's `event_type` field and the
 * "id" (svix event id, stable across delivery retries — the idempotency key) and
 * `status`/`amount_in_cents`/`metadata` fields are real, fetched directly from their
 * webhook docs. NOT independently confirmed: the exact `subscription.*` sub-event
 * names (their migration guide only confirmed the family exists, not each member) —
 * handled defensively below by reading the embedded `status` field instead of
 * gambling on an unconfirmed exact event name.
 */
export interface NormalizedBillingEvent {
  eventId: string;
  kind: 'payment_succeeded' | 'payment_failed' | 'subscription_status' | 'unhandled';
  providerPaymentId?: string;
  providerSubscriptionId?: string;
  amountUsdCents?: number;
  subscriptionStatus?: 'active' | 'paused' | 'past_due' | 'cancelled';
  metadata?: Record<string, string>;
}

interface RawRecurrenteEvent {
  id: string;
  event_type: string;
  status?: string;
  amount_in_cents?: number;
  payment?: { id?: string };
  checkout?: { id?: string; metadata?: Record<string, string> };
  metadata?: Record<string, string>;
}

export function verifyAndParseWebhook(params: {
  svixId: string;
  svixTimestamp: string;
  svixSignatureHeader: string;
  rawBody: string;
}): NormalizedBillingEvent {
  const valid = verifyRecurrenteWebhook(params);
  if (!valid) throw new Error('Invalid webhook signature');

  const raw = JSON.parse(params.rawBody) as RawRecurrenteEvent;
  const metadata = raw.checkout?.metadata ?? raw.metadata;

  if (raw.event_type.startsWith('intent.') || raw.event_type.startsWith('payment_intent.')) {
    if (raw.status === 'succeeded' || raw.status === 'paid') {
      return {
        eventId: raw.id,
        kind: 'payment_succeeded',
        providerPaymentId: raw.payment?.id,
        amountUsdCents: raw.amount_in_cents,
        metadata,
      };
    }
    if (raw.status === 'failed') {
      return {
        eventId: raw.id,
        kind: 'payment_failed',
        providerPaymentId: raw.payment?.id,
        amountUsdCents: raw.amount_in_cents,
        metadata,
      };
    }
  }

  if (raw.event_type.startsWith('subscription.')) {
    const knownStatuses = ['active', 'paused', 'past_due', 'cancelled'];
    if (raw.status && knownStatuses.includes(raw.status)) {
      return {
        eventId: raw.id,
        kind: 'subscription_status',
        providerSubscriptionId: raw.checkout?.id,
        subscriptionStatus: raw.status as NormalizedBillingEvent['subscriptionStatus'],
        metadata,
      };
    }
  }

  return { eventId: raw.id, kind: 'unhandled', metadata };
}

export const BASE_PLAN_AMOUNT_USD_CENTS = 4900; // USD 49/mes — CU-868kfvae6, valor real del ticket
export const appBaseUrl = env.appBaseUrl;
