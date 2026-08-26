import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { env } from '@/lib/env';
import * as schema from './schema';

// Runtime connection uses the restricted macha_app role (env.appDatabaseUrl,
// migration 0010), NOT the owner role that runs migrations — a table owner always
// bypasses REVOKE UPDATE/DELETE in Postgres, so the append-only ledger guarantee
// only holds for a role that never owns the tables. Falls back to DATABASE_URL
// until an operator provisions the real Railway role (see env.ts).
// Tenant scoping is enforced in guards; RLS reads app.company_id GUC set per
// request (see guards/tenant.derive.ts) and is FORCE-applied (migration 0010) so
// it also holds for this connection even though it may still be the owner locally.
/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * `idle_in_transaction_session_timeout` — LA RED QUE FALTABA (caída del 2026-08-26)
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *
 * Producción se cayó dos veces en el mismo día por causas distintas. La segunda fue esta, y
 * se vivió como "el login está roto" durante casi una hora:
 *
 *     pid 315 · transacción ABIERTA hace 57 minutos · idle todo ese tiempo
 *               última query: select "locale" from "users" where "users"."id" = $1
 *     9 sesiones bloqueadas, todas esperando a 315:
 *               insert into "metric_rollups" (...)
 *
 * Una request dejó una transacción sin `commit` ni `rollback`. `reserveScopedConnection`
 * (lib/db-scope.ts) hace `begin` y delega el cierre a un hook de Elysia; si ese hook no
 * corre —cliente que se desconecta, request abortada, un camino de salida no cubierto— la
 * transacción queda abierta para siempre sosteniendo sus locks.
 *
 * ═══ POR QUÉ TUMBÓ EL PRODUCTO ENTERO Y NO UNA PANTALLA ═══
 *
 * `upsertMonthlyRollup` inserta por clave única `(empresa, mes, tipo)` — LA MISMA para todas
 * las cargas de dashboard de esa empresa. Su `onConflictDoNothing` NO evita el bloqueo: ante
 * una clave duplicada, Postgres hace ESPERAR al segundo insert hasta saber si el primero
 * commitea o aborta. Así que cada carga se encolaba detrás de la transacción muerta hasta
 * llenar el pool (`max: 10`), y desde ahí TODO lo que toca la base fallaba de forma
 * intermitente. `/continue` es la primera puerta después del login, así que cuando la
 * llamada que moría era la suya el usuario quedaba atrapado en "El servicio no está
 * respondiendo" — indistinguible de un login roto.
 *
 * Los cuatro timeouts de la instancia estaban en 0 (sin límite), verificado.
 *
 * ═══ POR QUÉ ESTE TIMEOUT Y NO LOS OTROS TRES ═══
 *
 * Solo mata transacciones ABIERTAS y SIN ACTIVIDAD, nunca una query en curso, así que no
 * puede interrumpir trabajo real. Se verificó que ningún camino legítimo mantiene una
 * transacción idle: el worker de ingesta usa transacciones cortas y deja las llamadas al
 * modelo FUERA (nota en `queue/workers/excel-ingest.ts`), y las de request viven lo que dura
 * la request. Una transacción idle 60 s es siempre una fuga.
 *
 * `statement_timeout` queda FUERA a propósito: este mismo pool lo comparte la promoción de
 * miles de filas de Excel, y un límite global mataría trabajo bueno. `lock_timeout` también:
 * habría hecho fallar rápido a los nueve bloqueados —que era mejor que encolarlos— pero un
 * valor global alcanza a la promoción, donde abortar por contención SÍ pierde contabilidad.
 * El rollup es un caché y puede fallar; una promoción no.
 *
 * ⚠️ Esto acota el DAÑO, no arregla la fuga. La fuga vive en el cierre de
 * `reserveScopedConnection` y hay que perseguirla aparte; lo que esto garantiza es que la
 * próxima se limpie sola en un minuto en vez de tumbar el producto por una hora.
 */
const IDLE_TX_TIMEOUT_MS = 60_000;

export const sql = postgres(env.appDatabaseUrl, {
  max: 10,
  connection: { idle_in_transaction_session_timeout: IDLE_TX_TIMEOUT_MS },
});
export const db = drizzle(sql, { schema });
export type DB = typeof db;
export { schema };
