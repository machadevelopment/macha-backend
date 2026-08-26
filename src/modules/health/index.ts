import { Elysia } from 'elysia';
import { sql } from '@/db/client';
import { medirSaludDelPool, describirSalud } from '@/lib/db-health';

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * DOS CHEQUEOS, Y LA DIFERENCIA IMPORTA (caída del 2026-08-26)
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *
 * `GET /health` no toca la base a propósito: responde si el proceso está vivo y atendiendo. Eso
 * es correcto para lo que es, y **es exactamente por lo que engañó** durante la caída del
 * 2026-08-26: se le pegaron 20 llamadas seguidas con el producto muerto y devolvió 200 en las
 * 20, así que sirvió para DESCARTAR el backend justo cuando el backend era el problema.
 *
 * La causa era el pool de `macha_app` agotado (`max: 10`) por una transacción colgada. Un
 * chequeo que no toca la base no puede verlo ni en principio.
 *
 * `GET /health/db` es el que sí lo ve, y por eso es **el que debe configurarse como healthcheck
 * del servicio en Railway**. Con el pool agotado devuelve 503, Railway reinicia, las conexiones
 * se cierran y el rollback ocurre solo: la caída de aquel día se habría curado sin nadie
 * mirando.
 */
export const health = new Elysia({ prefix: '/health' })
  .get('/', () => ({ status: 'ok', service: 'macha-backend' }))
  /**
   * ⚠️ ESTE es el healthcheck del servicio en Railway, no `/health`.
   *
   * Devuelve 503 en dos casos, y los dos son "la app no puede atender":
   *   · la consulta de sondeo no se pudo hacer (base caída, o **pool sin conexiones libres**);
   *   · el pool está comprometido según `lib/db-health.ts` (fuga o varias sesiones bloqueadas).
   *
   * El segundo es el que convierte esto en algo útil: sin él, una conexión libre entre diez
   * atascadas seguiría devolviendo 200 mientras los usuarios ven errores.
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
        /*
         * 503 y no 200-con-aviso: el punto de este endpoint es que un orquestador pueda ACTUAR
         * sin leer el cuerpo. Un 200 con un campo `degradado: true` obliga a que alguien
         * programe la lectura de ese campo, y mientras nadie lo haga el chequeo no sirve —que
         * es la situación en la que estábamos.
         */
        set.status = 503;
        return { db: 'degradado', razon: describirSalud(salud) };
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
