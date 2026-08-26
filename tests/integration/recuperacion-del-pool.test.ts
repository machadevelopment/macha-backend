import { describe, expect, test, beforeAll, afterAll } from 'bun:test';
import postgres from 'postgres';
import { sql as q } from 'drizzle-orm';
import { setupTestDatabase, testOwnerUrl, testAppUrl } from './setup';

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA AUTO-RECUPERACIÓN, Y SOBRE TODO LO QUE NO DEBE TOCAR
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *
 * `recuperarTransaccionesColgadas` deshace transacciones abandonadas para liberar el pool. Es la
 * ÚNICA capa de auto-recuperación que existe: el healthcheck de Railway solo corre al desplegar
 * (*"Railway does not monitor the healthcheck endpoint after the deployment has gone live"*), y
 * de hecho ya estaba configurado durante la caída del 2026-08-26 sin reiniciar nada.
 *
 * ═══ EL PESO DE ESTE ARCHIVO ESTÁ EN LOS CASOS NEGATIVOS ═══
 *
 * Que la función haga su trabajo es la mitad fácil. La mitad que puede causar daño es que se
 * pase de largo: alcanzar una sesión ACTIVA aborta la promoción de un archivo a mitad de camino,
 * y alcanzar al rol DUEÑO deja una migración por la mitad. Cualquiera de las dos convierte el
 * arreglo de una caída en un bug peor, y ninguna se ve en un test del camino feliz.
 *
 * El umbral es parámetro para poder ejercitar los tres candados sin esperar dos minutos; que el
 * valor de producción esté en su lugar dentro del orden de las tres redes lo fija el último test.
 */

process.env.DATABASE_URL = testOwnerUrl;
process.env.APP_DATABASE_URL = testAppUrl;

const { recuperarTransaccionesColgadas } = await import('@/lib/db-health');

/**
 * Conexión propia con el rol de la app, deliberadamente FUERA del pool compartido de
 * `db/client.ts`.
 *
 * El primer intento de este archivo usaba `reserveScopedConnection`, y eso rompió los demás
 * tests: la recuperación cerraba conexiones del pool compartido y las pruebas siguientes se
 * quedaban sin base. La lección aplica también en producción — esta capa alcanza al pool de la
 * app, así que lo que se prueba tiene que ser desechable.
 */
function conexionDeApp() {
  return postgres(testAppUrl, { max: 1, onnotice: () => {}, connect_timeout: 10 });
}

describe('auto-recuperación del pool', () => {
  let owner: ReturnType<typeof postgres>;

  beforeAll(async () => {
    await setupTestDatabase();
    owner = postgres(testOwnerUrl, { max: 3, onnotice: () => {}, connect_timeout: 10 });
  });

  afterAll(async () => {
    await owner?.end();
  });

  /**
   * El candado del PLAZO: una transacción recién abierta está dentro de su tiempo legítimo. Sin
   * esto, la capa cortaría requests normales en vuelo.
   */
  test('NO toca una transacción abierta hace un instante', async () => {
    const app = conexionDeApp();
    try {
      await app`begin`;
      await app`select 1`;

      // Umbral de producción: 120 s. Esta tiene milisegundos.
      const r = await recuperarTransaccionesColgadas();
      expect(r.terminadas).toBe(0);

      // Y sigue viva.
      const [x] = await app<{ ok: number }[]>`select 1 as ok`;
      expect(x!.ok).toBe(1);
      await app`rollback`;
    } finally {
      await app.end({ timeout: 5 }).catch(() => {});
    }
  });

  /**
   * El candado del ESTADO. Una sesión `active` está ejecutando algo — es lo único que podría
   * perder contabilidad de un cliente, así que con umbral 0 (el caso más agresivo posible)
   * tampoco puede alcanzarla.
   */
  test('NO toca una sesión activa, ni con el umbral en 0', async () => {
    const app = conexionDeApp();
    try {
      await app`begin`;

      /*
       * `.execute()` y no la plantilla a secas: en postgres.js una consulta es PEREZOSA y no se
       * envía hasta que se le hace `await`. La primera versión de este test hacía
       * `const enVuelo = app\`select pg_sleep(2)\`` sin await, así que la consulta nunca salía y
       * la sesión seguía en `idle in transaction` — el test fallaba acusando al código de matar
       * una sesión activa que en realidad nunca estuvo activa.
       */
      const enVuelo = app`select pg_sleep(2)`.execute();
      await new Promise((r) => setTimeout(r, 500));

      // Se comprueba el estado REAL antes de afirmar nada: si la sesión no está `active`, este
      // test no está probando lo que dice probar.
      const [estado] = await owner<{ state: string }[]>`
        select state from pg_stat_activity
         where usename = 'macha_app' and query like '%pg_sleep%' and state = 'active'`;
      expect(estado?.state).toBe('active');

      const r = await recuperarTransaccionesColgadas(0);
      expect(r.terminadas).toBe(0);

      // Y la query llega a completarse: no fue interrumpida.
      await expect(enVuelo).resolves.toBeDefined();
      await app`rollback`;
    } finally {
      await app.end({ timeout: 5 }).catch(() => {});
    }
  });

  /**
   * El candado del ROL. Una transacción larga del rol DUEÑO es una migración; alcanzarla deja el
   * esquema a medias. Con umbral 0 y la transacción idle, lo único que la salva es el filtro por
   * `current_user`.
   */
  test('NO toca una transacción idle del rol dueño, ni con el umbral en 0', async () => {
    const dueno = postgres(testOwnerUrl, { max: 1, onnotice: () => {}, connect_timeout: 10 });
    try {
      await dueno`begin`;
      await dueno`select 1`;
      await new Promise((r) => setTimeout(r, 300));

      const r = await recuperarTransaccionesColgadas(0);
      expect(r.terminadas).toBe(0);

      const [x] = await dueno<{ ok: number }[]>`select 1 as ok`;
      expect(x!.ok).toBe(1);
      await dueno`rollback`;
    } finally {
      await dueno.end({ timeout: 5 }).catch(() => {});
    }
  });

  /**
   * El camino que SÍ debe actuar, y su efecto útil: el trabajo sin commit se descarta y el lock
   * queda libre. Eso es lo que devuelve el pool a la vida.
   */
  test('deshace una transacción colgada de la app y libera su lock', async () => {
    await owner.unsafe('create table if not exists prueba_recuperacion (n int primary key)');
    await owner.unsafe('truncate prueba_recuperacion');
    await owner.unsafe('grant select, insert on prueba_recuperacion to macha_app');

    const app = conexionDeApp();
    try {
      await app`begin`;
      await app`insert into prueba_recuperacion (n) values (7)`;
      await new Promise((r) => setTimeout(r, 300));

      const r = await recuperarTransaccionesColgadas(0);
      expect(r.terminadas).toBeGreaterThan(0);

      // 1) el trabajo sin commit no quedó
      const [n] = await owner<{ n: string }[]>`
        select count(*)::text as n from prueba_recuperacion`;
      expect(n!.n).toBe('0');

      // 2) el lock está libre: otra sesión inserta la MISMA clave sin quedarse esperando.
      const libre = await Promise.race([
        owner
          .unsafe("set local lock_timeout='2s'; insert into prueba_recuperacion (n) values (7)")
          .then(() => true)
          .catch(() => false),
        new Promise<boolean>((res) => setTimeout(() => res(false), 4000)),
      ]);
      expect(libre).toBe(true);
    } finally {
      await app.end({ timeout: 5 }).catch(() => {});
      await owner.unsafe('drop table if exists prueba_recuperacion').catch(() => {});
    }
  });

  /**
   * El ORDEN de las tres redes es parte del diseño: Postgres (60 s) → watchdog (90 s) →
   * recuperación (120 s). Si alguien adelanta esta capa, empieza a competir con el watchdog por
   * cerrar la misma transacción en vez de cubrir lo que al watchdog se le escapó — y el aviso
   * que emite ("se escapó de las otras dos redes") pasaría a ser mentira.
   */
  test('el umbral va después del watchdog y del timeout de Postgres', async () => {
    const health = await Bun.file('src/lib/db-health.ts').text();
    const scope = await Bun.file('src/lib/db-scope.ts').text();
    const client = await Bun.file('src/db/client.ts').text();

    const matar = Number(health.match(/UMBRAL_MATAR_SEG\s*=\s*(\d+)/)![1]) * 1000;
    const watchdog = Number(scope.match(/TIEMPO_MAXIMO_MS\s*=\s*([\d_]+)/)![1]!.replace(/_/g, ''));
    const pg = Number(client.match(/IDLE_TX_TIMEOUT_MS\s*=\s*([\d_]+)/)![1]!.replace(/_/g, ''));

    expect(matar).toBeGreaterThan(watchdog);
    expect(watchdog).toBeGreaterThan(pg);
  });

  /**
   * Los tres candados, leídos del propio criterio SQL. No sustituye a los tests de arriba —que
   * los ejercitan— pero deja el WHERE como contrato: si alguien quita una condición para
   * "recuperar más", esto falla antes de que se descubra en producción.
   */
  test('el criterio SQL conserva los tres candados', async () => {
    const fuente = await Bun.file('src/lib/db-health.ts').text();
    const fn = fuente.slice(fuente.indexOf('export async function recuperarTransaccionesColgadas'));
    expect(fn).toContain('usename = ${app}');
    // La valla de optimización: sin ella, `pg_terminate_backend` puede evaluarse ANTES de los
    // filtros y alcanzar conexiones que no pasaron ningún candado. Medido: mataba la suya.
    expect(fn).toContain('offset 0');
    expect(fn).toContain("state = 'idle in transaction'");
    expect(fn).toContain('pid <> pg_backend_pid()');
    // Y nunca sobre lo que está esperando un lock: eso está trabajando.
    expect(fn).not.toContain('pg_blocking_pids');
  });

  test('sin nada colgado no hace nada', async () => {
    void q; // el helper de drizzle no se usa en este archivo, pero el import documenta el patrón
    const r = await recuperarTransaccionesColgadas();
    expect(r.terminadas).toBe(0);
    expect(r.pids).toEqual([]);
  });
});
