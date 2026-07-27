import { createHmac, timingSafeEqual } from 'node:crypto';
import { env } from '@/lib/env';

/**
 * CU-868kfvaed: Recurrente webhooks use the svix format (verified against
 * docs.recurrente.com/guides-english/getting-started/webhooks) — signed content is
 * `${svix-id}.${svix-timestamp}.${rawBody}`, HMAC-SHA256 with the webhook endpoint's
 * signingSecret (format `whsec_<base64>`), header `svix-signature` holds one or more
 * space-separated `v1,<base64>` values.
 */
export function verifyRecurrenteWebhook(params: {
  svixId: string;
  svixTimestamp: string;
  rawBody: string;
  svixSignatureHeader: string;
}): boolean {
  if (!env.recurrenteWebhookSecret) {
    throw new Error('RECURRENTE_WEBHOOK_SECRET not configured — cannot verify webhook signatures.');
  }
  const secretBytes = Buffer.from(env.recurrenteWebhookSecret.split('_')[1] ?? '', 'base64');
  const signedContent = `${params.svixId}.${params.svixTimestamp}.${params.rawBody}`;
  const expected = createHmac('sha256', secretBytes).update(signedContent).digest('base64');

  return params.svixSignatureHeader
    .split(' ')
    .map((part) => part.split(',')[1])
    .filter((sig): sig is string => Boolean(sig))
    .some((sig) => {
      const a = Buffer.from(sig);
      const b = Buffer.from(expected);
      return a.length === b.length && timingSafeEqual(a, b);
    });
}
