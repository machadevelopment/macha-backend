// Centralized env access. Bun loads .env automatically.
function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}
export const env = {
  nodeEnv: process.env.NODE_ENV ?? 'development',
  port: Number(process.env.PORT ?? 3001),
  databaseUrl: req('DATABASE_URL'),
  // Restricted runtime role (migration 0010) — never owns tables, so REVOKE
  // UPDATE/DELETE on append-only ledgers actually holds (owners always bypass
  // REVOKE, unlike RLS which FORCE can apply to them). Falls back to DATABASE_URL
  // so single-role setups (local dev, until an operator provisions the real
  // Railway role) keep working — the append-only guarantee only becomes real once
  // APP_DATABASE_URL is actually set to a distinct, non-owning role.
  appDatabaseUrl: process.env.APP_DATABASE_URL ?? req('DATABASE_URL'),
  redisUrl: process.env.REDIS_URL ?? 'redis://localhost:6379',
  workosJwksUrl: process.env.WORKOS_JWKS_URL ?? '',
  anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? '',
  anthropicModel: process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-5',
  s3Region: process.env.S3_REGION ?? 'us-east-1',
  s3Bucket: process.env.S3_BUCKET ?? '',
  resendApiKey: process.env.RESEND_API_KEY ?? '',
  resendFromEmail: process.env.RESEND_FROM_EMAIL ?? 'notificaciones@macha.finance',
  sentryDsn: process.env.SENTRY_DSN ?? '',
  // Used to build absolute links in emails (reports/alerts, F6) and Recurrente
  // checkout success/cancel redirects (M8) — was read as a raw process.env in F6
  // (alerts.ts/reports.ts), centralized here now that a second consumer needs it.
  appBaseUrl: process.env.APP_BASE_URL ?? 'http://localhost:3000',
  // CU-868kfvae6: Recurrente (docs.recurrente.com) — single secret key auth
  // (X-SECRET-KEY), test/live variants determine sandbox vs real charges.
  recurrenteSecretKey: process.env.RECURRENTE_SECRET_KEY ?? '',
  recurrenteWebhookSecret: process.env.RECURRENTE_WEBHOOK_SECRET ?? '',
};
