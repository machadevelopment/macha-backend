import { env } from '@/lib/env';
import { BillingNotConfiguredError } from './billing-errors';

// CU-868kfvae6: Recurrente REST API (verified against docs.recurrente.com — base
// URL, auth header, /api/checkouts request/response shape, and the subscription
// status enum below are all real, fetched directly from their docs, not guessed).
const BASE_URL = 'https://app.recurrente.com/api';

function assertConfigured(): void {
  // CU-868kmwn3q: tipo propio, no un Error suelto. El mensaje de este throw llegaba
  // literal al navegador con el nombre de la variable de entorno dentro; ahora `app.ts`
  // lo traduce a un 503 limpio antes de responder.
  if (!env.recurrenteSecretKey) throw new BillingNotConfiguredError();
}

/** ¿Se puede cobrar en este entorno? Lo consulta `/register` para decidir sin lanzar. */
export function isBillingConfigured(): boolean {
  return Boolean(env.recurrenteSecretKey);
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  assertConfigured();
  const res = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: {
      'X-SECRET-KEY': env.recurrenteSecretKey,
      'Content-Type': 'application/json',
      ...init.headers,
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Recurrente API error ${res.status} on ${path}: ${body}`);
  }
  return res.json() as Promise<T>;
}

export interface CheckoutResponse {
  id: string;
  status: 'unpaid' | 'paid' | 'payment_in_progress' | 'expired';
  checkout_url: string;
  currency: 'GTQ' | 'USD';
  total_in_cents: number;
}

/** POST /api/checkouts — recurring item (charge_type='recurring') for the base subscription plan. */
export function createSubscriptionCheckout(params: {
  amountUsdCents: number;
  successUrl: string;
  cancelUrl: string;
  metadata?: Record<string, string>;
}): Promise<CheckoutResponse> {
  return request<CheckoutResponse>('/checkouts', {
    method: 'POST',
    body: JSON.stringify({
      items: [
        {
          name: 'Macha Finance — Plan base',
          charge_type: 'recurring',
          currency: 'USD',
          amount_in_cents: params.amountUsdCents,
          billing_interval: 'month',
          billing_interval_count: 1,
          quantity: 1,
          metadata: params.metadata,
        },
      ],
      success_url: params.successUrl,
      cancel_url: params.cancelUrl,
    }),
  });
}

/** POST /api/checkouts — one-off item (charge_type='one_time') for a credit top-up. */
export function createTopupCheckout(params: {
  amountUsdCents: number;
  successUrl: string;
  cancelUrl: string;
  metadata?: Record<string, string>;
}): Promise<CheckoutResponse> {
  return request<CheckoutResponse>('/checkouts', {
    method: 'POST',
    body: JSON.stringify({
      items: [
        {
          name: 'Macha Finance — Recarga de créditos',
          charge_type: 'one_time',
          currency: 'USD',
          amount_in_cents: params.amountUsdCents,
          quantity: 1,
          metadata: params.metadata,
        },
      ],
      success_url: params.successUrl,
      cancel_url: params.cancelUrl,
    }),
  });
}

export interface RecurrenteSubscription {
  id: string;
  status: 'active' | 'paused' | 'past_due' | 'cancelled';
  current_period_start: string;
  current_period_end: string;
}

export function getSubscription(providerSubscriptionId: string): Promise<RecurrenteSubscription> {
  return request<RecurrenteSubscription>(`/subscriptions/${providerSubscriptionId}`);
}

export function cancelSubscription(providerSubscriptionId: string): Promise<{ message: string }> {
  return request<{ message: string }>(`/subscriptions/${providerSubscriptionId}`, {
    method: 'DELETE',
  });
}
