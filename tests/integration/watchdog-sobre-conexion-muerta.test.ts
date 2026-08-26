import { describe, expect, test } from 'bun:test';
import { testOwnerUrl } from './setup';

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * ESCRIBIRLE A UNA CONEXIÓN QUE POSTGRES YA MATÓ TERMINA EL PROCESO
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *
 * Este es el mecanismo detrás del bucle de crash del 2026-08-26, y el motivo de que
 * `lib/orden-de-las-redes.ts` exista. En producción se veía así:
 *
 *     [db-scope] transacción sin cerrar tras 90000 ms: se hace ROLLBACK …
 *     TypeError: null is not an object (evaluating 'socket.write')
 *           at nextWrite (…/postgres/src/connection.js:255)
 *     error: script "start" exited with code 1
 *
 * ═══ POR QUÉ EN UN SUBPROCESO Y NO EN ESTE ═══
 *
 * Porque lo que hay que demostrar es **que el proceso muere**, y eso no se puede afirmar desde
 * adentro del proceso que muere. Tampoco se puede envolver en un `expect().toThrow()`: el
 * throw ocurre dentro del `setImmediate` con que postgres.js difiere sus escrituras, así que
 * no está en ninguna cadena de promesas y NINGÚN `try/catch` ni `.catch()` lo recibe. Ese es
 * justamente el hallazgo — el `void release(false).catch(...)` del watchdog parece cubrirlo y
 * no cubre nada.
 *
 * ═══ POR QUÉ ESTE TEST NO EXISTÍA ANTES ═══
 *
 * `watchdog-conexiones.test.ts` sí probaba el watchdog, con un plazo de 1 segundo. Pero el
 * pool de los tests conserva el `idle_in_transaction_session_timeout` de producción, así que
 * con el watchdog a 1 s la conexión SIEMPRE seguía viva cuando despertaba: el test verificaba
 * el watchdog en la única configuración que producción no tenía. Escalar un plazo sin escalar
 * el otro invierte el orden que se quería probar.
 *
 * Este test fija el mecanismo con la relación al derecho y al revés, así que no depende de que
 * alguien recuerde escalar los dos.
 */

/**
 * Corre el guion en un proceso aparte y devuelve cómo terminó.
 *
 * `postgresMs` es el `idle_in_transaction_session_timeout`; `rollbackMs` es cuándo se intenta
 * escribir. La relación entre los dos es todo lo que este test varía.
 */
async function correrEnSubproceso(postgresMs: number, rollbackMs: number) {
  const guion = `
    import postgres from 'postgres';
    const sql = postgres(${JSON.stringify(testOwnerUrl)}, {
      max: 2,
      onnotice: () => {},
      connection: { idle_in_transaction_session_timeout: ${postgresMs} },
    });
    const reservada = await sql.reserve();
    await reservada\`begin\`;
    await new Promise((r) => setTimeout(r, ${rollbackMs}));
    try {
      await reservada\`rollback\`;
    } catch {
      // Un rechazo manejable es exactamente lo que este test quiere ver en el caso sano.
    } finally {
      reservada.release();
    }
    // Se le da margen al setImmediate diferido de postgres.js para explotar, si va a hacerlo.
    await new Promise((r) => setTimeout(r, 800));
    console.log('SOBREVIVIO');
    process.exit(0);
  `;
  // `bun -e` (no `bun run -e`, que no existe): evalúa el guion como módulo, con `await` de
  // primer nivel y resolviendo `postgres` desde el `node_modules` del repo.
  const proc = Bun.spawn(['bun', '-e', guion], { stdout: 'pipe', stderr: 'pipe' });
  /*
   * Con plazo: cuando el crash ocurre, el proceso no siempre termina — a veces queda colgado
   * porque la promesa del `rollback` nunca se resuelve. "No sobrevivió" cubre las dos formas.
   */
  const terminado = await Promise.race([
    proc.exited.then(() => true),
    new Promise<boolean>((r) => setTimeout(() => r(false), 10_000)),
  ]);
  /*
   * Se MATA antes de leer, y ese orden importa: leer la salida de un proceso que sigue vivo
   * espera a que el stream termine, o sea para siempre. La primera versión de este helper leía
   * primero y el test se colgaba justo en el caso que quiere demostrar.
   */
  if (!terminado) proc.kill();
  const salida = await new Response(proc.stdout).text();
  const errores = await new Response(proc.stderr).text();
  return { sobrevivio: salida.includes('SOBREVIVIO'), errores };
}

describe('escribir sobre una conexión que Postgres ya terminó', () => {
  /*
   * EL BUG. Postgres mata a los 800 ms y la escritura llega a los 2.500: es el orden que tenía
   * producción (60 s / 90 s) con los mismos papeles y los tiempos comprimidos.
   */
  test('con la escritura DESPUÉS de la muerte, el proceso no sobrevive', async () => {
    const { sobrevivio, errores } = await correrEnSubproceso(800, 2_500);
    expect(sobrevivio).toBe(false);
    // Y que sea ESTE fallo y no otro: si algún día postgres.js lo maneja, hay que enterarse.
    expect(errores).toContain('socket.write');
  }, 30_000);

  /*
   * EL ARREGLO. Misma prueba con la relación al derecho —la escritura llega ANTES de que
   * Postgres mate— y el proceso sale limpio. Es la situación en la que el orden nuevo pone
   * siempre al watchdog.
   */
  test('con la escritura ANTES de la muerte, sale limpio', async () => {
    const { sobrevivio } = await correrEnSubproceso(10_000, 500);
    expect(sobrevivio).toBe(true);
  }, 30_000);
});
