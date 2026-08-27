import { describe, expect, test, beforeAll, afterAll, mock } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { ownerConnection, setupTestDatabase, testAppUrl, testOwnerUrl } from './setup';

process.env.DATABASE_URL = testOwnerUrl;
process.env.APP_DATABASE_URL = testAppUrl;
process.env.WORKOS_JWKS_URL = 'https://example.invalid/jwks';

mock.module('@/lib/auth', () => ({
  verifyToken: async (token: string) => ({ sub: token }),
}));

const rateLimitReal = await import('@/lib/rate-limit');
mock.module('@/lib/rate-limit', () => ({
  ...rateLimitReal,
  enforceTokenBucket: async () => null,
}));

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * EL CLIENTE QUE SE VA NO PUEDE DEJAR UNA TRANSACCIÓN ABIERTA
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *
 * En producción el watchdog de `db-scope` se disparaba **cada pocos minutos**, con el
 * contenedor recién desplegado y sin carga inusual:
 *
 *     [db-scope] transacción sin cerrar tras 90000 ms: se hace ROLLBACK … Es una FUGA
 *
 * El watchdog hacía su trabajo, así que no se caía nada. Pero es una red, no un arreglo — y lo
 * que tapaba es el mismo defecto que el 2026-08-26 dejó una transacción abierta 57 minutos,
 * nueve sesiones encoladas detrás de su lock y el producto sin base durante una hora.
 *
 * ═══ LA CAUSA, QUE EL PROPIO CÓDIGO YA NOMBRABA ═══
 *
 * Los guards reservan la conexión en el `derive` y delegan el cierre a `onAfterHandle` /
 * `onError`. Si el cliente **se desconecta a mitad del request** —cierra la pestaña, navega,
 * cancela un fetch— Elysia no considera que el request terminara ni que fallara, así que **no
 * corre ninguno de los dos**. La transacción queda abierta con sus locks hasta que el watchdog
 * la recoge 90 segundos después.
 *
 * El comentario de `db-scope.ts` ya listaba ese caso como el motivo de que el watchdog exista.
 * Lo que faltaba era cerrarlo en vez de taparlo.
 *
 * ═══ POR QUÉ ESTE TEST VA CONTRA POSTGRES DE VERDAD ═══
 *
 * Porque lo que hay que demostrar es que **no queda una transacción viva del otro lado**, y eso
 * solo se ve preguntándole a `pg_stat_activity`. Un doble del cliente comprobaría que se llamó
 * a una función; esto comprueba que la base quedó limpia, que es la propiedad que el incidente
 * de la caída pide garantizar.
 */
describe('una request abortada libera su conexión al instante', () => {
  let owner: ReturnType<typeof ownerConnection>;
  let app: ReturnType<typeof import('@/app').createApp>;
  const empresa = randomUUID();
  const usuario = randomUUID();

  /** Transacciones vivas del rol de la app, que es lo que la fuga dejaba atrás. */
  const abiertasDeLaApp = async (): Promise<number> => {
    const [f] = await owner<{ n: string }[]>`
      select count(*)::text as n
        from pg_stat_activity
       where usename = 'macha_app'
         and state in ('idle in transaction', 'idle in transaction (aborted)')`;
    return Number(f!.n);
  };

  beforeAll(async () => {
    await setupTestDatabase();
    owner = ownerConnection();
    app = (await import('@/app')).createApp();

    await owner`
      insert into companies (id, workos_org_id, name, industry, base_currency, locale)
      values (${empresa}, ${'org_' + empresa}, ${'Fuga ' + empresa}, 'retail', 'GTQ', 'es')`;
    await owner`
      insert into users (id, workos_user_id, email)
      values (${usuario}, ${'wos_' + usuario}, ${'fuga-' + usuario + '@ejemplo.com'})`;
    await owner`
      insert into company_users (company_id, user_id, role, status)
      values (${empresa}, ${usuario}, 'owner', 'active')`;
  });

  afterAll(async () => {
    /*
     * Se limpian las filas propias. `user-provisioning.test.ts` hace
     * `delete from company_users where true` en su arranque —un borrado de tabla entera— y en
     * un suite que corre TODO en un solo proceso, dejar filas ajenas vivas convierte el orden
     * de los archivos en parte del resultado. Limpiar acá es más barato que razonar sobre eso.
     */
    await owner`delete from company_users where company_id = ${empresa}`.catch(() => {});
    await owner`delete from companies where id = ${empresa}`.catch(() => {});
    await owner`delete from users where id = ${usuario}`.catch(() => {});
    await owner?.end({ timeout: 5 }).catch(() => {});
  });

  /*
   * EL CASO DE LA FUGA. Se aborta la señal mientras el request está en vuelo, que es lo que
   * hace un navegador cuando el usuario cierra la pestaña o cambia de pantalla.
   */
  test('abortar a mitad del request no deja la transacción abierta', async () => {
    const antes = await abiertasDeLaApp();

    const corte = new AbortController();
    const enVuelo = app
      .handle(
        new Request('http://localhost/me/memberships', {
          headers: { authorization: `Bearer wos_${usuario}`, 'x-company-id': empresa },
          signal: corte.signal,
        }),
      )
      .catch(() => undefined);

    // El abort dispara el listener del guard, que es lo que este test ejercita.
    corte.abort();
    await enVuelo;

    /*
     * Un margen corto: el cierre es asíncrono (hace `rollback` y devuelve la conexión), así que
     * hay que dejarlo terminar. Sigue siendo tres órdenes de magnitud menos que los 90 s del
     * watchdog, que es justo el punto — antes esta transacción vivía minuto y medio.
     */
    await new Promise((r) => setTimeout(r, 400));

    expect(await abiertasDeLaApp()).toBe(antes);
  });

  /*
   * La contraparte: un request que termina normal también cierra. Sin esto, "no quedan
   * transacciones abiertas" se podría cumplir por no haber abierto ninguna, y el test pasaría
   * con el guard roto.
   */
  test('y un request que termina normal también la cierra', async () => {
    const antes = await abiertasDeLaApp();

    const res = await app.handle(
      new Request('http://localhost/me/memberships', {
        headers: { authorization: `Bearer wos_${usuario}`, 'x-company-id': empresa },
      }),
    );
    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 200));

    expect(await abiertasDeLaApp()).toBe(antes);
  });
});
