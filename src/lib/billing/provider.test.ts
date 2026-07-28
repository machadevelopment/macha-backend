import { describe, expect, test } from 'bun:test';
import { createHmac } from 'node:crypto';

process.env.DATABASE_URL ??= 'postgres://smoke:smoke@localhost:5432/smoke';
const SECRET_B64 = Buffer.from('test-signing-secret-bytes').toString('base64');

// See webhook-verify.test.ts: env.ts is a shared singleton across the whole `bun
// test` run, so mutate it directly rather than relying on process.env import-order.
const { env } = await import('@/lib/env');
env.recurrenteWebhookSecret = `whsec_${SECRET_B64}`;

const { verifyAndParseWebhook } = await import('./provider');

const svixId = 'msg_1';
const svixTimestamp = '1700000000';

function signedEvent(raw: Record<string, unknown>) {
  const rawBody = JSON.stringify(raw);
  const signedContent = `${svixId}.${svixTimestamp}.${rawBody}`;
  const sig = createHmac('sha256', Buffer.from(SECRET_B64, 'base64'))
    .update(signedContent)
    .digest('base64');
  return { svixId, svixTimestamp, rawBody, svixSignatureHeader: `v1,${sig}` };
}

describe('verifyAndParseWebhook (CU-868kfvaed)', () => {
  test('lanza con firma inválida — nunca procesa un evento no verificado', () => {
    const rawBody = JSON.stringify({ id: 'evt_1', event_type: 'intent.succeeded' });
    expect(() =>
      verifyAndParseWebhook({ svixId, svixTimestamp, rawBody, svixSignatureHeader: 'v1,bogus==' }),
    ).toThrow();
  });

  test('normaliza intent succeeded/paid a payment_succeeded', () => {
    const params = signedEvent({
      id: 'evt_ok',
      event_type: 'intent.succeeded',
      status: 'succeeded',
      amount_in_cents: 4900,
      payment: { id: 'pay_1' },
      metadata: { companyId: 'c1', kind: 'subscription' },
    });
    const result = verifyAndParseWebhook(params);
    expect(result).toMatchObject({
      eventId: 'evt_ok',
      kind: 'payment_succeeded',
      providerPaymentId: 'pay_1',
      amountUsdCents: 4900,
    });
  });

  test('normaliza intent failed a payment_failed', () => {
    const params = signedEvent({
      id: 'evt_fail',
      event_type: 'payment_intent.updated',
      status: 'failed',
      payment: { id: 'pay_2' },
    });
    expect(verifyAndParseWebhook(params)).toMatchObject({
      eventId: 'evt_fail',
      kind: 'payment_failed',
    });
  });

  test('normaliza subscription.* con status conocido a subscription_status', () => {
    const params = signedEvent({
      id: 'evt_sub',
      event_type: 'subscription.updated',
      status: 'past_due',
      checkout: { id: 'chk_1' },
    });
    expect(verifyAndParseWebhook(params)).toMatchObject({
      eventId: 'evt_sub',
      kind: 'subscription_status',
      subscriptionStatus: 'past_due',
      providerSubscriptionId: 'chk_1',
    });
  });

  test('subscription.* con status desconocido cae a unhandled (no gambling en nombres no confirmados)', () => {
    const params = signedEvent({
      id: 'evt_unk',
      event_type: 'subscription.weird_event',
      status: 'quantum',
    });
    expect(verifyAndParseWebhook(params)).toMatchObject({ eventId: 'evt_unk', kind: 'unhandled' });
  });

  test('event_type desconocido cae a unhandled', () => {
    const params = signedEvent({ id: 'evt_other', event_type: 'refund.created' });
    expect(verifyAndParseWebhook(params)).toMatchObject({
      eventId: 'evt_other',
      kind: 'unhandled',
    });
  });
});
