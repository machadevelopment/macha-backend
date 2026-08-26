import { describe, expect, test, beforeAll, afterAll } from 'bun:test';
import postgres from 'postgres';
import { setupTestDatabase, testAppUrl, testOwnerUrl } from './setup';

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * UNA TRANSACCIÓN COLGADA NO PUEDE VOLVER A TUMBAR EL PRODUCTO (caída del 2026-08-26)
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *
 * Medido en producción: una transacción quedó abierta 57 minutos sin commit ni rollback, y las
 * otras nueve conexiones del pool se encolaron detrás de su lock sobre `metric_rollups`. Con
 * `max: 10`, eso deja cero conexiones libres y todo lo que toca la base falla de forma
 * intermitente. Se vivió como "el login está roto" porque `/continue` es la primera puerta
 * después de entrar. Los cuatro timeouts de la instancia estaban en 0.
 *
 * ═══ POR QUÉ ESTE TEST VA CONTRA POSTGRES DE VERDAD ═══
 *
 * `idle_in_transaction_session_timeout` se manda como parámetro de arranque de la conexión. Si
 * el nombre estuviera mal escrito, o el valor en la unidad equivocada, o la librería lo
 * ignorara, el código se vería EXACTAMENTE igual y el timeout no existiría. Un test que solo
 * lea `client.ts` afirmaría que la cadena está escrita, no que Postgres la aplica — que es la
 * misma trampa que ya se documentó con el favicon (200 y content-type correctos sobre un XML
 * que no parseaba).
 *
 * Por eso acá se abre una conexión con las MISMAS opciones que `db/client.ts` y se le pregunta
 * a Postgres qué quedó configurado.
 */

const IDLE_TX_TIMEOUT_MS = 60_000;

describe('timeout de transacción colgada', () => {
  let app: ReturnType<typeof postgres>;

  beforeAll(async () => {
    await setupTestDatabase();
    // Mismas opciones que src/db/client.ts. Si alguien las cambia allá y no acá, el test de
    // abajo que compara contra el fuente lo detecta.
    app = postgres(testAppUrl, {
      max: 1,
      onnotice: () => {},
      connect_timeout: 10,
      connection: { idle_in_transaction_session_timeout: IDLE_TX_TIMEOUT_MS },
    });
  });

  afterAll(async () => {
    await app?.end();
  });

  /**
   * LA aserción que importa: se le pregunta al pool REAL de la app —el `sql` que exporta
   * `db/client.ts`— qué quedó configurado del otro lado.
   *
   * El primer intento de este test abría su propia conexión con el valor escrito a mano y
   * además buscaba la cadena en el fuente del archivo. Pasaba en verde con el timeout QUITADO
   * del pool, por dos motivos: la conexión propia no prueba nada sobre la de la app, y la
   * cadena aparecía en el COMENTARIO. Comprobado por mutación. Es la misma trampa que ya
   * costó el favicon: probar el texto de la implementación en vez de lo que el sistema hace.
   */
  test('el pool de la app tiene el timeout aplicado, según Postgres', async () => {
    const { sql: poolDeLaApp } = await import('@/db/client');
    const [r] = await poolDeLaApp<{ setting: string }[]>`
      select setting from pg_settings where name = 'idle_in_transaction_session_timeout'
    `;
    expect(Number(r!.setting)).toBe(IDLE_TX_TIMEOUT_MS);
    // Explícito: 0 es "sin límite", que es el estado con el que se cayó producción.
    expect(r!.setting).not.toBe('0');
  });

  /**
   * La prueba de fuego, y la aserción correcta. El primer intento comprobaba que un `select`
   * posterior fallara — y pasaba en verde por el motivo equivocado: la librería `postgres`
   * RECONECTA sola, así que la query tiene éxito en una conexión nueva y esconde que la sesión
   * murió. Lo que de verdad garantiza el timeout es que el trabajo no commiteado **se revierta
   * y suelte sus locks**, y eso se ve desde AFUERA.
   *
   * Se usa un timeout corto para no esperar un minuto en CI: lo que se verifica acá es el
   * MECANISMO; el valor real lo fija el test de arriba.
   */
  test('una transacción abandonada se revierte y suelta sus locks', async () => {
    const owner = postgres(testOwnerUrl, { max: 1, onnotice: () => {}, connect_timeout: 10 });
    const corta = postgres(testAppUrl, {
      max: 1,
      onnotice: () => {},
      connect_timeout: 10,
      connection: { idle_in_transaction_session_timeout: 800 },
    });
    try {
      // Tabla de trabajo sin RLS: lo que se prueba es el timeout, no el aislamiento.
      await owner.unsafe('create table if not exists prueba_tx_colgada (n int primary key)');
      await owner.unsafe('truncate prueba_tx_colgada');
      await owner.unsafe('grant select, insert on prueba_tx_colgada to macha_app');

      await corta`begin`;
      await corta`insert into prueba_tx_colgada (n) values (1)`;
      // Desde acá la transacción queda ABIERTA, con una fila sin commitear y su lock puesto:
      // exactamente el estado del pid 315 en producción.

      const [antes] = await owner<
        { n: string }[]
      >`select count(*)::text as n from prueba_tx_colgada`;
      expect(antes!.n).toBe('0'); // no commiteada: nadie más la ve

      await new Promise((r) => setTimeout(r, 2500));

      // 1) la fila NO quedó: Postgres revirtió la transacción abandonada
      const [despues] = await owner<
        { n: string }[]
      >`select count(*)::text as n from prueba_tx_colgada`;
      expect(despues!.n).toBe('0');

      // 2) y el lock está libre: otra sesión puede insertar la MISMA clave sin esperar. Este
      //    es el punto exacto de la caída — los nueve bloqueados esperaban justo esto.
      const insertoSinBloquearse = await Promise.race([
        owner
          .unsafe("set local lock_timeout='2s'; insert into prueba_tx_colgada (n) values (1)")
          .then(() => true)
          .catch(() => false),
        new Promise<boolean>((r) => setTimeout(() => r(false), 4000)),
      ]);
      expect(insertoSinBloquearse).toBe(true);
    } finally {
      await corta.end({ timeout: 5 }).catch(() => {});
      await owner.unsafe('drop table if exists prueba_tx_colgada').catch(() => {});
      await owner.end({ timeout: 5 }).catch(() => {});
    }
  });

  /**
   * Sin esto, alguien puede subir `max` o mover el timeout en `client.ts` y este archivo
   * seguiría probando un valor que ya no es el del producto.
   */
  test('el timeout está en la LLAMADA a postgres(), no solo en un comentario', async () => {
    const fuente = await Bun.file('src/db/client.ts').text();
    const llamada = fuente.slice(fuente.indexOf('export const sql = postgres('));
    // Acotado a la llamada a propósito: buscarlo en el archivo entero lo encuentra en la
    // cabecera de documentación y deja pasar un pool sin timeout (pasó, por mutación).
    expect(llamada).toContain('idle_in_transaction_session_timeout');
  });

  /**
   * `statement_timeout` y `lock_timeout` quedan FUERA a propósito: este pool lo comparte la
   * promoción de miles de filas de Excel, y abortarla por contención pierde contabilidad del
   * cliente. Si alguien los agrega, tiene que ser una decisión consciente — no un descuido al
   * copiar la línea de al lado.
   */
  test('no se agregaron timeouts que puedan matar una promoción', async () => {
    const fuente = await Bun.file('src/db/client.ts').text();
    const config = fuente.slice(fuente.indexOf('export const sql = postgres('));
    expect(config).not.toContain('statement_timeout');
    expect(config).not.toContain('lock_timeout');
  });
});
