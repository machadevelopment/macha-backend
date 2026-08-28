import { Elysia } from 'elysia';
import { sql } from '@/db/client';
import { medirSaludDelPool, describirSalud } from '@/lib/db-health';

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * DOS CHEQUEOS, Y LA DIFERENCIA IMPORTA (caída del 2026-08-26 · deploy fallido 2026-08-28)
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *
 * `GET /health` no toca la base a propósito: responde si el proceso está vivo y atendiendo.
 * Eso es correcto para lo que es, y **es exactamente por lo que engañó** durante la caída
 * del 2026-08-26: se le pegaron 20 llamadas seguidas con el producto muerto y devolvió 200
 * en las 20.
 *
 * `GET /health/db` SÍ toca la base. Es el healthcheck de Railway. Contesta una sola
 * pregunta: **¿ESTE proceso puede hablar con Postgres?** `SELECT 1` ok → 200; no se pudo
 * → 503.
 *
 * ⚠️ NO DEVUELVE 503 POR FUGAS DEL POOL. Esa fue la trampa del 2026-08-28: Railway solo
 * mira este endpoint AL DESPLEGAR (*"does not monitor the healthcheck after the deployment
 * has gone live"*). Un 503 por transacciones `idle in transaction` del contenedor VIEJO
 * —las que deja `POST /insights` mientras espera a Claude— hace que el replica NUEVO
 * nunca se ponga healthy. El deploy muere, la fuga se queda, y el arreglo no entra. Es
 * un candado que se cierra a sí mismo.
 *
 * Las fugas las cura `pool-watch` (cada 2 min) y el watchdog de `db-scope` (90 s). Este
 * endpoint las NOMBRA en el cuerpo (`atencion`) para que un `curl` las vea, y sigue
 * diciendo 200 para que Railway deje pasar al proceso que sí puede atender.
 */
export const health = new Elysia({ prefix: '/health' })
  .get('/', () => ({ status: 'ok', service: 'macha-backend' }))
  /**
   * ⚠️ ESTE es el healthcheck del servicio en Railway, no `/health`.
   *
   * 503 solo si ESTE proceso no pudo sondear la base (caída, o pool local sin
   * conexiones libres — `SELECT 1` espera y lanza). Una fuga en otra sesión no es
   * eso: el sondeo acaba de funcionar.
   */
  .get('/db', async ({ set }) => {
    try {
      const [row] = await sql`SELECT 1 AS ok`;
      if (row?.ok !== 1) {
        set.status = 503;
        return { db: 'error', razon: 'la consulta de sondeo no devolvió 1' };
      }

      const salud = await medirSaludDelPool();
      if (salud.requiereAtencion) {
        return { db: 'ok', atencion: describirSalud(salud) };
      }

      return { db: 'ok' };
    } catch (err) {
      /*
       * Con el pool agotado, `sql\`SELECT 1\`` se queda esperando una conexión libre y termina
       * lanzando. Ese throw ES la señal, así que se traduce a 503 en vez de dejarlo subir como
       * 500: un healthcheck tiene que responder algo interpretable incluso cuando la base no.
       */
      set.status = 503;
      return { db: 'error', razon: err instanceof Error ? err.message : String(err) };
    }
  });
