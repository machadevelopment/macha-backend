// Centralized env access. Bun loads .env automatically.
//
// `||`, NUNCA `??`, para resolver los defaults de abajo. La diferencia no es de estilo:
// `??` solo cae al default con `undefined`/`null`, y una variable **presente pero vacía**
// es el estado normal en Railway/Vercel (la UI guarda la clave con valor vacío) y es
// exactamente lo que trae `.env.example` — `APP_DATABASE_URL=` se deja vacía a propósito
// hasta el paso 4 del runbook de `macha_app`. Con `??` eso resolvía a `''`, y
// `postgres('')` no falla: se conecta a los defaults de libpq (localhost, base = nombre
// del usuario del SO), así que TODA query moría con `database "<usuario>" does not exist`
// mientras `/health` seguía devolviendo 200 —no toca la base— y el healthcheck de Railway
// daba el deploy por bueno. Con `||` la cadena vacía cae al default, que es lo que
// cualquiera espera al leer esta lista.
function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}
export const env = {
  // Esta línea depende de `--env=disable` en el script `build` (package.json). Sin esa
  // bandera, `bun build` sustituye `process.env.NODE_ENV` por un LITERAL en tiempo de
  // build — y la etapa `build` del Dockerfile no tiene NODE_ENV seteada, así que el
  // bundle salía con `nodeEnv: "development"` incrustado y la variable de Railway no
  // hacía nada. Verificado contra el despliegue real: `/` respondía
  // `{"env":"development"}` con `NODE_ENV=production` puesta en la plataforma.
  // Es exclusivo de NODE_ENV; el resto de `process.env` sobrevive al bundling.
  nodeEnv: process.env.NODE_ENV || 'development',
  // `Number('')` es 0, no NaN: con `??` un PORT vacío hacía escuchar en un puerto
  // efímero al azar en vez de en 3001.
  port: Number(process.env.PORT || 3001),
  databaseUrl: req('DATABASE_URL'),
  // Restricted runtime role (migration 0010) — never owns tables, so REVOKE
  // UPDATE/DELETE on append-only ledgers actually holds (owners always bypass
  // REVOKE, unlike RLS which FORCE can apply to them). Falls back to DATABASE_URL
  // so single-role setups (local dev, until an operator provisions the real
  // Railway role) keep working — the append-only guarantee only becomes real once
  // APP_DATABASE_URL is actually set to a distinct, non-owning role.
  appDatabaseUrl: process.env.APP_DATABASE_URL || req('DATABASE_URL'),
  // CU-868kjbw5h: el fallback de arriba es un fallo de configuración SILENCIOSO — la app
  // funciona idéntico sin aislamiento. Estas dos banderas lo vuelven observable y, cuando
  // el operador lo decide, fatal. Ver src/lib/db-role-check.ts.
  appDatabaseUrlIsExplicit: Boolean(process.env.APP_DATABASE_URL),
  // Se setea a 'true' en staging/prod DESPUÉS de crear el rol y verificarlo; a partir de
  // ahí, arrancar sin aislamiento aborta el proceso en vez de degradarse en silencio.
  requireIsolatedDbRole: process.env.REQUIRE_ISOLATED_DB_ROLE === 'true',
  redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',
  workosJwksUrl: process.env.WORKOS_JWKS_URL ?? '',

  // CU-868kjkfdf: solo se usa para dar de alta una identidad NUEVA (una vez por usuario
  // en toda su vida). El access token de WorkOS no lleva email ni nombre, y `users.email`
  // es NOT NULL — así que el perfil se le pide a la Management API por el `sub` que ya
  // venía firmado, nunca al cliente. Ver src/lib/workos-users.ts.
  workosApiKey: process.env.WORKOS_API_KEY ?? '',
  anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? '',
  anthropicModel: process.env.ANTHROPIC_MODEL || 'claude-sonnet-5',
  s3Region: process.env.S3_REGION || 'us-east-1',
  s3Bucket: process.env.S3_BUCKET ?? '',
  resendApiKey: process.env.RESEND_API_KEY ?? '',
  resendFromEmail: process.env.RESEND_FROM_EMAIL || 'notificaciones@macha.finance',
  sentryDsn: process.env.SENTRY_DSN ?? '',
  // Used to build absolute links in emails (reports/alerts, F6) and Recurrente
  // checkout success/cancel redirects (M8) — was read as a raw process.env in F6
  // (alerts.ts/reports.ts), centralized here now that a second consumer needs it.
  appBaseUrl: process.env.APP_BASE_URL || 'http://localhost:3000',
  // CU-868kfvae6: Recurrente (docs.recurrente.com) — single secret key auth
  // (X-SECRET-KEY), test/live variants determine sandbox vs real charges.
  recurrenteSecretKey: process.env.RECURRENTE_SECRET_KEY ?? '',
  recurrenteWebhookSecret: process.env.RECURRENTE_WEBHOOK_SECRET ?? '',
  // CU-868kfvar3: retención del pg_dump nocturno en S3 (segunda capa de respaldo,
  // aparte del backup nativo de Railway — configuración de consola, no vive aquí).
  // Vacía, `??` daba `Number('')` = 0 — es decir, retención CERO: el job de limpieza
  // habría borrado todos los backups por considerarlos vencidos.
  backupRetentionDays: Number(process.env.BACKUP_RETENTION_DAYS || 30),
};
