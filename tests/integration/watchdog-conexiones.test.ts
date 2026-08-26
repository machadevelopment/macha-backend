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
   * ⚠️ ESTE TEST EXIGÍA EL ORDEN QUE TUMBÓ PRODUCCIÓN, y su comentario explicaba con
   * convicción por qué: *"El plazo de producción tiene que quedar POR ENCIMA del
   * `idle_in_transaction_session_timeout` … Si alguien invierte el orden, la red de afuera se
   * dispara antes que la de adentro y el watchdog deja de servir."*
   *
   * La premisa era que las dos redes hacen lo mismo y la de adentro tiene que ganar. No hacen
   * lo mismo: **el watchdog ESCRIBE `rollback` sobre la conexión y el timeout de Postgres MATA
   * el backend.** Con el watchdog último, escribía sobre una sesión que Postgres ya había
   * terminado treinta segundos antes, y eso no "deja de servir": revienta el proceso entero —
   * `socket.write` sobre null, dentro de un `setImmediate` de postgres.js, fuera de toda
   * promesa, sin `catch` que lo alcance. Producción quedó en bucle de crash y ninguna carga de
   * Excel podía terminar.
   *
   * La preocupación de fondo era real y sigue cubierta, solo que al revés: el watchdog tiene
   * que dispararse PRIMERO, porque es el único que devuelve la conexión utilizable. Lo que el
   * timeout de Postgres cubre y el watchdog no es otra cosa (una transacción abierta fuera de
   * `reserveScopedConnection`), y para eso sigue estando.
   *
   * `watchdog-sobre-conexion-muerta.test.ts` prueba el mecanismo en un subproceso; el orden
   * completo vive en `lib/orden-de-las-redes.ts` con su propio test.
   */
  test('el plazo del watchdog es MENOR que el timeout de Postgres', async () => {
    const { WATCHDOG_MS, IDLE_TX_TIMEOUT_MS } = await import('@/lib/orden-de-las-redes');
    expect(WATCHDOG_MS).toBeLessThan(IDLE_TX_TIMEOUT_MS);

    // Y que el watchdog use de verdad esa constante, no un número propio que nadie sincroniza.
    const scope = await Bun.file('src/lib/db-scope.ts').text();
    expect(scope).toContain('const TIEMPO_MAXIMO_MS = WATCHDOG_MS;');
  });
});
