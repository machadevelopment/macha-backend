import { and, eq, isNull, sql as rawSql } from 'drizzle-orm';
import type { DB } from '@/db/client';
import { metricRollups, transactions } from '@/db/schema';

export type RollupType = 'revenue' | 'cogs' | 'opex' | 'other';
export const ROLLUP_TYPES: RollupType[] = ['revenue', 'cogs', 'opex', 'other'];

/**
 * CU-868kfvab1: cache-aside dashboard rollups (data model.md §4.15). Only
 * `granularity='month'`, `category=NULL` (per-type monthly totals) is populated in
 * v1 — enough for the fixed KPIs (ingresos/costos/margen). Quarter/year granularity
 * and per-category rollups are the same shape but unused until a ticket needs them.
 *
 * NOTE on upsert: `metric_rollups_uq` is UNIQUE(company_id, granularity, period,
 * type, category), but `category` is nullable and SQL NULLs are never equal to each
 * other in a unique check — `ON CONFLICT` on that index would never match our
 * category=NULL rows and would insert duplicates instead of updating. So this uses
 * explicit select-then-update-or-insert instead of `onConflictDoUpdate`.
 */
async function sumTransactionsForMonth(
  db: DB,
  companyId: string,
  period: string,
  type: RollupType,
): Promise<number> {
  const [row] = await db
    .select({ total: rawSql<string>`coalesce(sum(${transactions.amountBase}), 0)` })
    .from(transactions)
    .where(
      and(
        eq(transactions.companyId, companyId),
        eq(transactions.type, type),
        isNull(transactions.deletedAt),
        rawSql`date_trunc('month', ${transactions.date}) = ${period}::date`,
      ),
    );
  return Number(row?.total ?? 0);
}

async function upsertMonthlyRollup(
  db: DB,
  companyId: string,
  period: string,
  type: RollupType,
  amountBase: number,
): Promise<void> {
  const [existing] = await db
    .select({ id: metricRollups.id })
    .from(metricRollups)
    .where(
      and(
        eq(metricRollups.companyId, companyId),
        eq(metricRollups.granularity, 'month'),
        eq(metricRollups.period, period),
        eq(metricRollups.type, type),
        isNull(metricRollups.category),
      ),
    );

  if (existing) {
    await db
      .update(metricRollups)
      .set({ amountBase: String(amountBase), computedAt: new Date() })
      .where(eq(metricRollups.id, existing.id));
  } else {
    await db.insert(metricRollups).values({
      companyId,
      granularity: 'month',
      period,
      type,
      category: null,
      amountBase: String(amountBase),
    });
  }
}

/** First-access lazy fill (criterio 2): compute+store if missing, else return the cached value untouched. */
export async function getOrComputeMonthlyAmount(
  db: DB,
  companyId: string,
  period: string,
  type: RollupType,
): Promise<number> {
  const [existing] = await db
    .select({ amountBase: metricRollups.amountBase })
    .from(metricRollups)
    .where(
      and(
        eq(metricRollups.companyId, companyId),
        eq(metricRollups.granularity, 'month'),
        eq(metricRollups.period, period),
        eq(metricRollups.type, type),
        isNull(metricRollups.category),
      ),
    );
  if (existing) return Number(existing.amountBase);

  const amount = await sumTransactionsForMonth(db, companyId, period, type);
  await upsertMonthlyRollup(db, companyId, period, type, amount);
  return amount;
}

/**
 * Ingestion-completion hook (criterio 1/2): recompute only rollups that already
 * exist for this company ("previously seen" — never-seen ones stay lazy, filled at
 * first /metrics read). Called after a successful promotion in the excel-ingest
 * worker.
 */
export async function refreshExistingRollups(db: DB, companyId: string): Promise<void> {
  const existing = await db
    .select({ period: metricRollups.period, type: metricRollups.type })
    .from(metricRollups)
    .where(
      and(
        eq(metricRollups.companyId, companyId),
        eq(metricRollups.granularity, 'month'),
        isNull(metricRollups.category),
      ),
    );

  for (const row of existing) {
    if (!row.type) continue;
    const amount = await sumTransactionsForMonth(db, companyId, row.period, row.type as RollupType);
    await upsertMonthlyRollup(db, companyId, row.period, row.type as RollupType, amount);
  }
}
