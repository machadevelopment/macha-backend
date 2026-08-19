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
  planName?: string;
  /**
   * Plan destino de un CAMBIO de plan (CU-868ku66du).
   *
   * Con este campo el checkout deja de ser solo el del alta: el webhook necesita saber a qué
   * plan mover la suscripción cuando el pago se confirme, y el `metadata` del proveedor es el
   * único canal que sobrevive al viaje ida y vuelta por Recurrente.
   *
   * Sin él, el metadata sigue siendo `kind: 'subscription'` exactamente como antes — el alta
   * de empresa no cambia de comportamiento.
   */
  targetPlanCode?: string;
}): Promise<CheckoutResult> {
  const checkout = await recurrenteCreateSubscriptionCheckout({
    amountUsdCents: params.amountUsdCents,
    successUrl: params.successUrl,
    cancelUrl: params.cancelUrl,
    planName: params.planName,
    metadata: params.targetPlanCode
      ? {
          companyId: params.companyId,
          kind: 'plan_change',
          targetPlanCode: params.targetPlanCode,
          // El monto viaja también: el webhook lo escribe en `amountUsdCents` de la
          // suscripción, y leerlo del catálogo en ese momento daría el precio de HOY y no el
          // que el cliente aceptó pagar. Los precios del catálogo son provisionales y pueden
          // moverse entre que alguien abre el checkout y lo completa.
          targetAmountUsdCents: String(params.amountUsdCents),
        }
      : { companyId: params.companyId, kind: 'subscription' },
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
  /**
   * CU-868kn4ken — id del CHECKOUT, que es lo que `subscriptions.provider_checkout_id`
   * guarda y por tanto lo único con lo que se puede casar la suscripción. Antes el
   * handler comparaba contra `providerPaymentId`, que es otro identificador distinto.
   */
  providerCheckoutId?: string;
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
        // CU-868kn4ken: los pagos de PRUEBA de Recurrente no traen objeto `payment`
        // (su intent lleva prefijo `pa_test_` y no hay pago enlazado), así que
        // `providerPaymentId` viene vacío. El checkout sí está en las dos modalidades.
        providerCheckoutId: raw.checkout?.id,
        amountUsdCents: raw.amount_in_cents,
        metadata,
      };
    }
    if (raw.status === 'failed') {
      return {
        eventId: raw.id,
        kind: 'payment_failed',
        providerPaymentId: raw.payment?.id,
        providerCheckoutId: raw.checkout?.id,
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
