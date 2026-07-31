import { drizzle } from 'drizzle-orm/postgres-js';
import { sql, schema, type DB } from '@/db/client';

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
export async function reserveScopedConnection(): Promise<ScopedConnection> {
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
    try {
      if (commitTx) await reserved`commit`;
      else await reserved`rollback`;
    } finally {
      reserved.release();
    }
  };

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
