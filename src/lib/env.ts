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
  /*
   * Modelo SOLO para la clasificación de Excel, separado del general a propósito.
   *
   * La ingesta es el 98 % del gasto de IA (ledger del 2026-08-12) y, desde que el modelo
   * dejó de reconstruir las filas, es la tarea más simple del producto: entidad, tipo,
   * categoría. El chat y los insights son lo contrario — poco volumen, cara al cliente,
   * donde la calidad se nota.
   *
   * Un solo `ANTHROPIC_MODEL` obligaba a decidir por los dos a la vez. Con esta variable, el
   * día que se confirme ZDR para un modelo más barato se cambia la ingesta sin tocar nada
   * más. Vacía = mismo modelo que todo lo demás, que es el estado actual.
   *
   * ⚠️ AL CAMBIARLO, MIRAR EL MÍNIMO DE CACHÉ DEL MODELO NUEVO. El caché de prompt solo
   * existe si el prefijo supera un mínimo que DEPENDE DEL MODELO y no es monótono entre
   * generaciones: 1.024 tokens en Sonnet 5, 4.096 en Haiku 4.5. Por debajo no cachea y no
   * avisa — `cache_creation_input_tokens` simplemente queda en 0.
   *
   * Nuestro prefijo (prompt de sistema + bloque de plantilla) mide ~4.817 tokens medidos el
   * 2026-08-12: pasa el umbral de Haiku, pero por 700 tokens. Acortar el prompt de sistema
   * lo dejaría por debajo y mataría el 44 % de acierto de caché sin que nada falle.
   */
  anthropicIntakeModel:
    process.env.ANTHROPIC_INTAKE_MODEL || process.env.ANTHROPIC_MODEL || 'claude-sonnet-5',
  s3Region: process.env.S3_REGION || 'us-east-1',
  s3Bucket: process.env.S3_BUCKET ?? '',
  // Estas dos existían en `.env.example` y en la tabla de "requeridas" del README desde
  // el principio, pero NADIE las leía: `s3.ts` construía el cliente solo con la región y
  // el SDK caía a su cadena de credenciales por defecto, que busca `AWS_ACCESS_KEY_ID` /
  // `AWS_SECRET_ACCESS_KEY` — otros nombres. Con la configuración documentada, toda
  // subida moría con `Could not load credentials from any providers`. Visto en
  // producción al subir el primer Excel real.
  s3AccessKeyId: process.env.S3_ACCESS_KEY_ID ?? '',
  s3SecretAccessKey: process.env.S3_SECRET_ACCESS_KEY ?? '',
  resendApiKey: process.env.RESEND_API_KEY ?? '',
  resendFromEmail: process.env.RESEND_FROM_EMAIL || 'notificaciones@macha.finance',
  sentryDsn: process.env.SENTRY_DSN ?? '',
  // CU-868kmr1tb: el nombre de entorno que Sentry pone en cada evento. Va aparte de
  // NODE_ENV a propósito — Railway corre staging Y producción con NODE_ENV=production,
  // así que etiquetar por NODE_ENV los vuelve indistinguibles. Ver src/lib/sentry.ts.
  sentryEnvironment: process.env.SENTRY_ENVIRONMENT ?? '',
  // La inyecta Railway sola en todos sus servicios ('production'/'staging'). Sirve para
  // dos cosas: etiquetar el entorno sin que nadie tenga que configurar nada, y saber que
  // esto ES un deploy —y no un `bun run dev`— cuando falta el DSN.
  railwayEnvironment: process.env.RAILWAY_ENVIRONMENT_NAME ?? '',
  // Used to build absolute links in emails (reports/alerts, F6) and Recurrente
  // checkout success/cancel redirects (M8) — was read as a raw process.env in F6
  // (alerts.ts/reports.ts), centralized here now that a second consumer needs it.
  appBaseUrl: process.env.APP_BASE_URL || 'http://localhost:3000',
  // CU-868kfvae6: Recurrente (docs.recurrente.com) — single secret key auth
  // (X-SECRET-KEY), test/live variants determine sandbox vs real charges.
  recurrenteSecretKey: process.env.RECURRENTE_SECRET_KEY ?? '',
  recurrenteWebhookSecret: process.env.RECURRENTE_WEBHOOK_SECRET ?? '',
  /**
   * CU-868kmxu41 — permite completar el registro SIN pasar por el checkout, para
   * onboarding de pilotos mientras el proveedor de pagos no está contratado.
   *
   * Es opt-in explícito y no un fallback automático a propósito: si "sin clave de
   * Recurrente" bastara para saltarse el cobro, olvidar la variable en producción
   * regalaría cuentas en silencio. Sin esta bandera, un entorno sin proveedor rechaza
   * el registro con un 503 claro; con ella, la empresa se crea y su suscripción queda
   * en `pending_checkout`, que es exactamente lo que es.
   */
  billingCheckoutOptional: process.env.BILLING_CHECKOUT_OPTIONAL === 'true',
  // CU-868kfvar3: retención del pg_dump nocturno en S3 (segunda capa de respaldo,
  // aparte del backup nativo de Railway — configuración de consola, no vive aquí).
  // Vacía, `??` daba `Number('')` = 0 — es decir, retención CERO: el job de limpieza
  // habría borrado todos los backups por considerarlos vencidos.
  backupRetentionDays: Number(process.env.BACKUP_RETENTION_DAYS || 30),
};
