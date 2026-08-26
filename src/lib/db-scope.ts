import { drizzle } from 'drizzle-orm/postgres-js';
import { sql, schema, type DB } from '@/db/client';

/**
 * Cuánto se espera a que el dueño de una conexión reservada la cierre antes de forzar el
 * rollback. Ver la cabecera del watchdog más abajo para por qué 90 s y por qué va DESPUÉS del
 * timeout de Postgres.
 */
const TIEMPO_MAXIMO_MS = 90_000;

export interface ScopedConnection {
  db: DB;
  /**
   * Sets another GUC with SET LOCAL on this same transaction.
   *
   * La unión cerrada es deliberada: son los tres únicos GUC que leen las políticas de
   * RLS, y tenerlos enumerados aquí hace que añadir un cuarto sea un cambio visible en
   * este archivo y no una cadena suelta en cualquier módulo. `app.cross_tenant` en
   * particular abre la visibilidad cross-company y solo debe salir de `admin.guard`
   * (CU-868kjc4af).
   */
  scopeTo: (
    guc: 'app.user_id' | 'app.company_id' | 'app.cross_tenant',
    value: string,
  ) => Promise<void>;
  commit: () => Promise<void>;
  rollback: () => Promise<void>;
}

/**
 * Reserves a dedicated connection and opens a transaction on it. The caller owns its
 * lifecycle and MUST call commit or rollback exactly once (both release the connection
 * back to the pool).
 *
 * Low-level primitive shared by the two usage patterns in this codebase:
 * - request-scoped (guards/tenant.derive.ts): reserve now, defer commit/rollback to
 *   Elysia's onAfterHandle/onError hooks — the actual handler runs later, driven by
 *   Elysia itself, not as a callback we control.
 * - one-shot (withCompanyScope below, used by pg-boss workers): reserve, run a
 *   callback, commit/rollback immediately — there is no request lifecycle to hook into.
 *
 * CU-868kj3utc: los GUC se setean por separado y no en la reserva porque el guard los
 * descubre en dos tiempos — primero la identidad (`app.user_id`, lo único que permite
 * leer las propias membresías bajo RLS, ver migración 0012) y solo después la empresa
 * (`app.company_id`). Ambos con SET LOCAL en la MISMA transacción: si la identidad
 * viviera en otra conexión, la empresa resuelta no estaría cubierta por el mismo
 * backstop.
 */
export async function reserveScopedConnection(
  /**
   * Solo los tests lo pasan. Es un parámetro y no una variable de entorno a propósito: el
   * valor de producción es una decisión de diseño (ver la cabecera del watchdog), no algo que
   * convenga poder aflojar desde un panel a las 3 de la mañana.
   */
  tiempoMaximoMs: number = TIEMPO_MAXIMO_MS,
): Promise<ScopedConnection> {
  const reserved = await sql.reserve();
  await reserved`begin`;

  // HALLAZGO (CU-868kj3utc, detectado por los tests de integración): el objeto que
  // devuelve `sql.reserve()` NO expone `.options` —solo `types/typed/unsafe/notify/
  // array/json/file/release`— y `drizzle()` lo primero que hace es escribir en
  // `client.options.parsers` para desactivar el parseo de fechas. Sin esto, cualquier
  // uso de una conexión reservada revienta con `undefined is not an object
  // (evaluating 'client.options.parsers')`: es decir, TODO request autenticado y todo
  // job de pg-boss que use withCompanyScope. No se había visto porque hasta ahora
  // ningún test abría una conexión real y los guards fallaban antes de llegar aquí.
  //
  // Se reusa el `options` del pool padre a propósito: `db/client.ts` ya llamó a
  // `drizzle(sql)` sobre ese mismo objeto, así que los parsers transparentes ya están
  // puestos y volver a ponerlos es idempotente. Copiar el objeto, en cambio, dejaría
  // la conexión reservada con un parseo de fechas distinto al del pool.
  (reserved as unknown as { options: unknown }).options = sql.options;

  let released = false;
  const release = async (commitTx: boolean) => {
    if (released) return;
    released = true;
    clearTimeout(guardia);
    try {
      if (commitTx) await reserved`commit`;
      else await reserved`rollback`;
    } finally {
      reserved.release();
    }
  };

  /*
   * ═══════════════════════════════════════════════════════════════════════════════════════
   * EL WATCHDOG: EL CIERRE NO PUEDE DEPENDER DE QUE UN HOOK SE EJECUTE
   * ═══════════════════════════════════════════════════════════════════════════════════════
   *
   * La cabecera de arriba lo dice sin darle peso: en el patrón por request, el
   * `commit`/`rollback` se delega a los hooks de Elysia. El 2026-08-26 eso tumbó producción
   * durante una hora, y así se veía en la base:
   *
   *     pid 315 · transacción ABIERTA hace 57 minutos · idle todo ese tiempo
   *     9 sesiones bloqueadas esperándola: insert into "metric_rollups" (...)
   *     macha_app: 10 de 10 conexiones
   *
   * Si el hook no corre —cliente que se desconecta, request abortada, un camino de salida no
   * cubierto— la transacción queda abierta con sus locks y la conexión nunca vuelve al pool.
   * Con `max: 10`, diez fugas dejan el producto sin base. Y el síntoma no se parece a la
   * causa: se vivió como "el login está roto", porque `/continue` es la primera puerta
   * después de entrar.
   *
   * Este temporizador convierte el cierre en una garantía de ESTE archivo. Ya no importa qué
   * haga Elysia: si nadie cerró en `TIEMPO_MAXIMO_MS`, se hace rollback y la conexión vuelve.
   *
   * ═══ POR QUÉ ROLLBACK Y NUNCA COMMIT ═══
   *
   * Una transacción que llegó al watchdog es, por definición, una cuyo dueño se perdió. No se
   * sabe si terminó su trabajo. Commitear a ciegas escribiría contabilidad a medias en un
   * producto financiero; el rollback deja las cosas como estaban, que es la única opción
   * defendible cuando no se sabe.
   *
   * ═══ POR QUÉ 90 SEGUNDOS, Y POR QUÉ MÁS QUE EL DE POSTGRES ═══
   *
   * `db/client.ts` pone `idle_in_transaction_session_timeout` en 60 s. Este va DESPUÉS a
   * propósito: el de Postgres cubre lo que está idle, y este cubre lo que ya no está idle
   * porque quedó esperando un lock —justo el estado de las nueve sesiones de la caída, que
   * NO son "idle in transaction" y por lo tanto ese timeout no las alcanza—.
   *
   * Son dos redes para dos estados distintos, no una redundante. Y 90 s es holgado: ninguna
   * request legítima dura tanto (el worker de ingesta usa transacciones cortas y deja las
   * llamadas al modelo FUERA, ver `queue/workers/excel-ingest.ts`), así que llegar acá
   * siempre significa que algo se rompió.
   *
   * `unref()` para no mantener vivo el proceso por un temporizador pendiente: un contenedor
   * que no puede terminar su apagado es la forma de arreglar esto creando otro problema.
   */
  /*
   * `guardia` se declara DESPUÉS de `release` y este la referencia: es seguro porque `release`
   * nunca se invoca de forma sincrónica antes de esta línea — la primera llamada llega desde
   * un hook de Elysia, del worker, o desde este propio temporizador.
   */
  const guardia = setTimeout(() => {
    console.error(
      `[db-scope] transacción sin cerrar tras ${tiempoMaximoMs} ms: se hace ROLLBACK y se ` +
        'devuelve la conexión al pool. Es una FUGA — alguien reservó y nadie cerró. ' +
        'Ver la cabecera del watchdog en lib/db-scope.ts.',
    );
    void release(false).catch((err) => {
      console.error('[db-scope] el rollback del watchdog falló:', err);
    });
  }, tiempoMaximoMs);
  guardia.unref?.();

  return {
    db: drizzle(reserved, { schema }),
    // set_config(..., true) es SET LOCAL: se revierte al cerrar la transacción, así que
    // el GUC nunca sobrevive en la conexión que vuelve al pool.
    scopeTo: async (guc, value) => {
      await reserved`select set_config(${guc}, ${value}, true)`;
    },
    commit: () => release(true),
    rollback: () => release(false),
  };
}

/**
 * Reserva una conexión ya scopeada a una empresa — el caso de los workers y de todo lo
 * que conoce el `company_id` de antemano. Sets app.company_id via SET LOCAL so RLS
 * applies (backstop, guards are the primary enforcement).
 */
export async function reserveCompanyConnection(companyId: string): Promise<ScopedConnection> {
  const scoped = await reserveScopedConnection();
  try {
    await scoped.scopeTo('app.company_id', companyId);
  } catch (err) {
    await scoped.rollback();
    throw err;
  }
  return scoped;
}

/**
 * One-shot company-scoped DB access for code that runs OUTSIDE an HTTP request — e.g.
 * pg-boss workers (excel ingestion, report generation, alert evaluation). There is no
 * Elysia Request/hooks to defer cleanup to, so this reserves, runs `fn`, commits on
 * success / rolls back on throw, and always releases the connection.
 *
 * company_id here MUST come from the job payload as enqueued server-side (never from
 * user input reaching the worker) — same non-negotiable rule as the HTTP guard.
 */
export async function withCompanyScope<T>(
  companyId: string,
  fn: (db: DB) => Promise<T>,
): Promise<T> {
  const { db, commit, rollback } = await reserveCompanyConnection(companyId);
  try {
    const result = await fn(db);
    await commit();
    return result;
  } catch (err) {
    await rollback();
    throw err;
  }
}
