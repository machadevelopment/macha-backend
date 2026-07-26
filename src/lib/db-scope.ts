import { drizzle } from 'drizzle-orm/postgres-js';
import { sql, schema, type DB } from '@/db/client';

/**
 * Reserves a dedicated connection, opens a transaction, and sets app.company_id via
 * SET LOCAL so RLS applies (backstop, guards are the primary enforcement). The caller
 * owns the reserved connection's lifecycle and MUST call commit or rollback exactly
 * once (both release the connection back to the pool).
 *
 * Low-level primitive shared by the two usage patterns in this codebase:
 * - request-scoped (guards/tenant.derive.ts): reserve now, defer commit/rollback to
 *   Elysia's onAfterHandle/onError hooks — the actual handler runs later, driven by
 *   Elysia itself, not as a callback we control.
 * - one-shot (withCompanyScope below, used by pg-boss workers): reserve, run a
 *   callback, commit/rollback immediately — there is no request lifecycle to hook into.
 */
export async function reserveCompanyConnection(companyId: string): Promise<{
  db: DB;
  commit: () => Promise<void>;
  rollback: () => Promise<void>;
}> {
  const reserved = await sql.reserve();
  await reserved`begin`;
  await reserved`select set_config('app.company_id', ${companyId}, true)`;

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
    commit: () => release(true),
    rollback: () => release(false),
  };
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
