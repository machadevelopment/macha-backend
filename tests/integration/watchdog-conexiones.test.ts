import { describe, expect, test, beforeAll, afterAll } from 'bun:test';
import postgres from 'postgres';
import { setupTestDatabase, testOwnerUrl, testAppUrl } from './setup';

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * EL WATCHDOG DE CONEXIONES RESERVADAS (caída del 2026-08-26)
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *
 * `reserveScopedConnection` abre una transacción y delega el cierre a los hooks de Elysia. Si
 * el hook no corre, la transacción queda abierta con sus locks y la conexión no vuelve al
 * pool. Medido en producción: una duró 57 minutos con nueve sesiones encoladas detrás, y con
 * `max: 10` eso dejó al producto sin base.
 *
 * Lo que se prueba acá es la GARANTÍA, no el valor: que una conexión reservada y abandonada se
 * cierre sola, haga ROLLBACK y devuelva la conexión — sin que nadie llame a `commit` ni a
 * `rollback`.
 *
 * Va contra Postgres real porque lo que importa es lo que queda del otro lado: que la fila no
 * se escribió y que el lock se soltó. Un test con un doble del cliente afirmaría que se llamó
 * a una función, no que la base quedó limpia.
 */

process.env.DATABASE_URL = testOwnerUrl;
process.env.APP_DATABASE_URL = testAppUrl;

const { reserveScopedConnection } = await import('@/lib/db-scope');
const { sql: q } = await import('drizzle-orm');

describe('watchdog de conexiones reservadas', () => {
  let owner: ReturnType<typeof postgres>;

  beforeAll(async () => {
    await setupTestDatabase();
    owner = postgres(testOwnerUrl, { max: 2, onnotice: () => {}, connect_timeout: 10 });
    await owner.unsafe('create table if not exists prueba_watchdog (n int primary key)');
    await owner.unsafe('grant select, insert on prueba_watchdog to macha_app');
  });

  afterAll(async () => {
    await owner?.unsafe('drop table if exists prueba_watchdog').catch(() => {});
    await owner?.end();
  });

  test('una conexión abandonada hace ROLLBACK sola y libera el lock', async () => {
    await owner.unsafe('truncate prueba_watchdog');

    // Se reserva y se escribe, y NUNCA se llama commit ni rollback: la fuga exacta de la caída.
    const abandonada = await reserveScopedConnection(700);
    await abandonada.db.execute(q`insert into prueba_watchdog (n) values (1)`);

    const [antes] = await owner<{ n: string }[]>`select count(*)::text as n from prueba_watchdog`;
    expect(antes!.n).toBe('0'); // sin commit, nadie más la ve

    await new Promise((r) => setTimeout(r, 2000));

    // 1) el trabajo no commiteado se revirtió
    const [despues] = await owner<{ n: string }[]>`select count(*)::text as n from prueba_watchdog`;
    expect(despues!.n).toBe('0');

    // 2) y el lock quedó libre: otra sesión inserta la MISMA clave sin quedarse esperando.
    //    Este es el punto exacto de la caída — las nueve sesiones bloqueadas esperaban esto.
    const libre = await Promise.race([
      owner
        .unsafe("set local lock_timeout='2s'; insert into prueba_watchdog (n) values (1)")
        .then(() => true)
        .catch(() => false),
      new Promise<boolean>((r) => setTimeout(() => r(false), 4000)),
    ]);
    expect(libre).toBe(true);
  });

  /**
   * Que el watchdog NO se meta con una transacción sana es la mitad que puede hacer daño: si
   * cortara transacciones legítimas, arreglar la caída habría creado un bug peor —contabilidad
   * revertida a mitad de una promoción.
   */
  test('no toca una transacción que se cierra a tiempo, y el commit persiste', async () => {
    await owner.unsafe('truncate prueba_watchdog');

    const sana = await reserveScopedConnection(5_000);
    await sana.db.execute(q`insert into prueba_watchdog (n) values (42)`);
    await sana.commit();

    const [r] = await owner<{ n: string }[]>`select count(*)::text as n from prueba_watchdog`;
    expect(r!.n).toBe('1');

    // Y pasado el plazo original nada se deshace: el temporizador se limpió al cerrar.
    await new Promise((x) => setTimeout(x, 1200));
    const [r2] = await owner<{ n: string }[]>`select count(*)::text as n from prueba_watchdog`;
    expect(r2!.n).toBe('1');
  });

  /**
   * `commit` y `rollback` tras el watchdog no pueden explotar: los hooks de Elysia igual van a
   * llamarlos si la request termina tarde, y un throw ahí se convierte en un 500 sobre una
   * request que ya no tiene transacción que salvar.
   */
  test('cerrar después de que el watchdog actuó es inofensivo', async () => {
    const tarde = await reserveScopedConnection(500);
    await new Promise((r) => setTimeout(r, 1500));
    await expect(tarde.commit()).resolves.toBeUndefined();
    await expect(tarde.rollback()).resolves.toBeUndefined();
  });

  /**
   * El plazo de producción tiene que quedar POR ENCIMA del `idle_in_transaction_session_timeout`
   * del pool: ese cubre lo que está idle, y el watchdog cubre lo que quedó esperando un lock,
   * que NO es "idle in transaction" y por eso ese timeout no lo alcanza. Si alguien invierte el
   * orden, la red de afuera se dispara antes que la de adentro y el watchdog deja de servir.
   */
  test('el plazo del watchdog es mayor que el timeout de Postgres', async () => {
    const scope = await Bun.file('src/lib/db-scope.ts').text();
    const client = await Bun.file('src/db/client.ts').text();
    const wd = Number(scope.match(/TIEMPO_MAXIMO_MS\s*=\s*([\d_]+)/)![1]!.replace(/_/g, ''));
    const pg = Number(client.match(/IDLE_TX_TIMEOUT_MS\s*=\s*([\d_]+)/)![1]!.replace(/_/g, ''));
    expect(wd).toBeGreaterThan(pg);
  });
});
