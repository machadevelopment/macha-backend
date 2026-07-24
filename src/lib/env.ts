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
  redisUrl: process.env.REDIS_URL ?? 'redis://localhost:6379',
  workosJwksUrl: process.env.WORKOS_JWKS_URL ?? '',
  anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? '',
  anthropicModel: process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-5',
  s3Region: process.env.S3_REGION ?? 'us-east-1',
  s3Bucket: process.env.S3_BUCKET ?? '',
  resendApiKey: process.env.RESEND_API_KEY ?? '',
  sentryDsn: process.env.SENTRY_DSN ?? '',
};
