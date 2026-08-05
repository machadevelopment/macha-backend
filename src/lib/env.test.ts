import { describe, expect, test } from 'bun:test';

/**
 * Regresión del bug que rompía el despliegue: una variable **presente pero vacía**
 * —el estado normal de Railway/Vercel cuando se guarda la clave sin valor, y lo que
 * trae `.env.example` a propósito para `APP_DATABASE_URL`— no caía al default con `??`.
 * `postgres('')` no falla al construirse: se conecta a los defaults de libpq, así que la
 * app arrancaba, `/health` devolvía 200 (no toca la base) y el healthcheck de Railway
 * daba el deploy por bueno mientras toda query moría con
 * `database "<usuario-del-so>" does not exist`.
 *
 * Se evalúa en un subproceso porque `env.ts` resuelve todo en el import, una sola vez
 * por proceso: para probar varios entornos hay que arrancar varios procesos. Es además
 * el camino real de arranque, no una simulación.
 */
async function resolveEnv(overrides: Record<string, string>): Promise<Record<string, unknown>> {
  const proc = Bun.spawn(
    [
      'bun',
      '-e',
      'const { env } = await import("./src/lib/env.ts"); console.log(JSON.stringify(env));',
    ],
    {
      cwd: new URL('../..', import.meta.url).pathname,
      env: { ...process.env, ...overrides },
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  if ((await proc.exited) !== 0) throw new Error(`env.ts no cargó: ${stderr}`);
  return JSON.parse(stdout);
}

const OWNER_URL = 'postgres://owner:pw@db.example:5432/macha';

describe('env — variables presentes pero vacías', () => {
  test('APP_DATABASE_URL vacía cae a DATABASE_URL, no a cadena vacía', async () => {
    const env = await resolveEnv({ DATABASE_URL: OWNER_URL, APP_DATABASE_URL: '' });
    expect(env.appDatabaseUrl).toBe(OWNER_URL);
  });

  test('APP_DATABASE_URL vacía sigue contando como NO explícita (el aislamiento no está activo)', async () => {
    const env = await resolveEnv({ DATABASE_URL: OWNER_URL, APP_DATABASE_URL: '' });
    expect(env.appDatabaseUrlIsExplicit).toBe(false);
  });

  test('APP_DATABASE_URL con valor real se usa y se marca explícita', async () => {
    const appUrl = 'postgres://macha_app:pw@db.example:5432/macha';
    const env = await resolveEnv({ DATABASE_URL: OWNER_URL, APP_DATABASE_URL: appUrl });
    expect(env.appDatabaseUrl).toBe(appUrl);
    expect(env.appDatabaseUrlIsExplicit).toBe(true);
  });

  test('PORT vacío escucha en 3001, no en un puerto al azar', async () => {
    const env = await resolveEnv({ DATABASE_URL: OWNER_URL, PORT: '' });
    expect(env.port).toBe(3001);
  });

  test('BACKUP_RETENTION_DAYS vacío no da retención cero', async () => {
    const env = await resolveEnv({ DATABASE_URL: OWNER_URL, BACKUP_RETENTION_DAYS: '' });
    expect(env.backupRetentionDays).toBe(30);
  });

  test('los defaults de texto no se quedan en vacío', async () => {
    const env = await resolveEnv({
      DATABASE_URL: OWNER_URL,
      NODE_ENV: '',
      REDIS_URL: '',
      ANTHROPIC_MODEL: '',
      S3_REGION: '',
      APP_BASE_URL: '',
      RESEND_FROM_EMAIL: '',
    });
    expect(env.nodeEnv).toBe('development');
    expect(env.redisUrl).toBe('redis://localhost:6379');
    expect(env.anthropicModel).toBe('claude-sonnet-5');
    expect(env.s3Region).toBe('us-east-1');
    expect(env.appBaseUrl).toBe('http://localhost:3000');
    expect(env.resendFromEmail).toBe('notificaciones@macha.finance');
  });
});
