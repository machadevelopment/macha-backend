import * as Sentry from '@sentry/bun';
import { env } from './env';

// CU-868kfv9ur: no-op without a real DSN (local/dev/CI never set SENTRY_DSN — same
// pattern as every other optional integration in this repo, e.g. Resend/S3). Only
// Railway staging/prod get a real DSN, set out-of-band like every other secret here.
export function initSentry(): void {
  if (!env.sentryDsn) return;
  Sentry.init({ dsn: env.sentryDsn, environment: env.nodeEnv, tracesSampleRate: 0.1 });
}
