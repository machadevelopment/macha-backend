import { describe, expect, test } from 'bun:test';
import { createHmac } from 'node:crypto';

process.env.DATABASE_URL ??= 'postgres://smoke:smoke@localhost:5432/smoke';
const SECRET_B64 = Buffer.from('test-signing-secret-bytes').toString('base64');

// bun test loads every file's imports into ONE shared module registry — env.ts is a
// singleton, so a sibling test file may have already imported it before this file
// ran, caching an empty recurrenteWebhookSecret regardless of what we set on
// process.env now. Mutate the shared `env` object directly instead (it's a plain
// exported const, not frozen) so this test is independent of suite run order.
const { env } = await import('@/lib/env');
env.recurrenteWebhookSecret = `whsec_${SECRET_B64}`;

const { verifyRecurrenteWebhook } = await import('./webhook-verify');

function sign(svixId: string, svixTimestamp: string, rawBody: string): string {
  const signedContent = `${svixId}.${svixTimestamp}.${rawBody}`;
  const sig = createHmac('sha256', Buffer.from(SECRET_B64, 'base64'))
    .update(signedContent)
    .digest('base64');
  return `v1,${sig}`;
}

describe('verifyRecurrenteWebhook (CU-868kfvaed — firma svix)', () => {
  const svixId = 'msg_123';
  const svixTimestamp = '1700000000';
  const rawBody = JSON.stringify({ id: 'evt_1', event_type: 'intent.created' });

  test('acepta una firma válida', () => {
    const header = sign(svixId, svixTimestamp, rawBody);
    expect(
      verifyRecurrenteWebhook({ svixId, svixTimestamp, rawBody, svixSignatureHeader: header }),
    ).toBe(true);
  });

  test('rechaza una firma inválida', () => {
    const header = 'v1,' + Buffer.from('not-the-real-signature').toString('base64');
    expect(
      verifyRecurrenteWebhook({ svixId, svixTimestamp, rawBody, svixSignatureHeader: header }),
    ).toBe(false);
  });

  test('rechaza si el body fue alterado después de firmar (protege idempotencia/integridad)', () => {
    const header = sign(svixId, svixTimestamp, rawBody);
    const tamperedBody = JSON.stringify({
      id: 'evt_1',
      event_type: 'intent.created',
      status: 'succeeded',
    });
    expect(
      verifyRecurrenteWebhook({
        svixId,
        svixTimestamp,
        rawBody: tamperedBody,
        svixSignatureHeader: header,
      }),
    ).toBe(false);
  });

  test('acepta cuando el header trae varias firmas espacio-separadas (rotación de secreto)', () => {
    const header = `v1,bogus== ${sign(svixId, svixTimestamp, rawBody)}`;
    expect(
      verifyRecurrenteWebhook({ svixId, svixTimestamp, rawBody, svixSignatureHeader: header }),
    ).toBe(true);
  });
});
