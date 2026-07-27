import { and, eq, gte, isNull, sql as rawSql } from 'drizzle-orm';
import type { DB } from '@/db/client';
import { alertRules, alertEvents, invoices, transactions, companies, companyUsers, users } from '@/db/schema';
import { getOrComputeMonthlyAmount } from '@/lib/rollups';
import { getCreditBalance } from '@/lib/credits';
import { creditsConfig } from '@/config/credits';
import { getPlatformSetting, SETTINGS_KEYS } from '@/lib/settings';
import { sendAlertTriggeredEmail } from '@/lib/email';
import { alertCatalog } from '@/config/alert-catalog';
import { env } from '@/lib/env';

const NO_REPEAT_DAYS = 7;

function monthStart(monthsAgo: number): string {
  const d = new Date();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() - monthsAgo);
  return d.toISOString().slice(0, 10);
}

async function evalArOverdue(db: DB, companyId: string, threshold: number): Promise<number | null> {
  const today = new Date().toISOString().slice(0, 10);
  const rows = await db
    .select({ dueDate: invoices.dueDate })
    .from(invoices)
    .where(and(eq(invoices.companyId, companyId), eq(invoices.status, 'open'), isNull(invoices.deletedAt)));

  let maxDaysOverdue = 0;
  for (const row of rows) {
    if (!row.dueDate || row.dueDate >= today) continue;
    const days = Math.floor((Date.parse(today) - Date.parse(row.dueDate)) / 86_400_000);
    maxDaysOverdue = Math.max(maxDaysOverdue, days);
  }
  return maxDaysOverdue >= threshold ? maxDaysOverdue : null;
}

async function evalPortfolioConcentration(db: DB, companyId: string, threshold: number): Promise<number | null> {
  const rows = await db
    .select({
      counterparty: invoices.counterparty,
      total: rawSql<string>`sum(${invoices.amountBase})`,
    })
    .from(invoices)
    .where(and(eq(invoices.companyId, companyId), eq(invoices.status, 'open'), isNull(invoices.deletedAt)))
    .groupBy(invoices.counterparty);

  const grandTotal = rows.reduce((acc, r) => acc + Number(r.total), 0);
  if (grandTotal === 0) return null;
  const maxShare = Math.max(...rows.map((r) => (Number(r.total) / grandTotal) * 100));
  return maxShare >= threshold ? maxShare : null;
}

async function evalRevenueDrop(db: DB, companyId: string, threshold: number): Promise<number | null> {
  const current = await getOrComputeMonthlyAmount(db, companyId, monthStart(0), 'revenue');
  const priors = await Promise.all(
    [1, 2, 3].map((i) => getOrComputeMonthlyAmount(db, companyId, monthStart(i), 'revenue')),
  );
  const avgPrior = priors.reduce((a, b) => a + b, 0) / priors.length;
  if (avgPrior === 0) return null;
  const dropPct = ((avgPrior - current) / avgPrior) * 100;
  return dropPct >= threshold ? dropPct : null;
}

async function evalMarginDrop(db: DB, companyId: string, threshold: number): Promise<number | null> {
  const period = monthStart(0);
  const revenue = await getOrComputeMonthlyAmount(db, companyId, period, 'revenue');
  const cogs = await getOrComputeMonthlyAmount(db, companyId, period, 'cogs');
  if (revenue === 0) return null;
  const marginPct = ((revenue - cogs) / revenue) * 100;
  return marginPct < threshold ? marginPct : null;
}

/**
 * "Una categoría de costo supera su promedio de 3 meses" (alert-catalog.ts) —
 * evaluada por (type, category) real, no solo por type, porque `category` es el
 * único nivel de detalle que el ledger tiene además del tipo fijo. Requiere que la
 * categoría tenga gasto en los 3 meses previos (si no, se ignora — "requiere >=3
 * meses de historia"); devuelve la MAYOR desviación entre todas las categorías.
 */
async function evalSpendOutOfRange(db: DB, companyId: string, threshold: number): Promise<number | null> {
  const periods = [0, 1, 2, 3].map(monthStart);
  const rows = await db
    .select({
      category: transactions.category,
      type: transactions.type,
      period: rawSql<string>`date_trunc('month', ${transactions.date})::date`,
      total: rawSql<string>`sum(${transactions.amountBase})`,
    })
    .from(transactions)
    .where(
      and(
        eq(transactions.companyId, companyId),
        rawSql`${transactions.type} in ('cogs','opex')`,
        isNull(transactions.deletedAt),
        gte(transactions.date, periods[3]!),
      ),
    )
    .groupBy(transactions.category, transactions.type, rawSql`date_trunc('month', ${transactions.date})`);

  const byCategory = new Map<string, Map<string, number>>();
  for (const row of rows) {
    const key = `${row.type}:${row.category}`;
    if (!byCategory.has(key)) byCategory.set(key, new Map());
    byCategory.get(key)!.set(row.period, Number(row.total));
  }

  let maxDeviation: number | null = null;
  for (const [, byPeriod] of byCategory) {
    const priorMonths = [1, 2, 3].map((i) => byPeriod.get(periods[i]!));
    if (priorMonths.some((v) => v === undefined)) continue; // needs full 3-month history
    const avgPrior = (priorMonths as number[]).reduce((a, b) => a + b, 0) / 3;
    if (avgPrior === 0) continue;
    const current = byPeriod.get(periods[0]!) ?? 0;
    const deviationPct = ((current - avgPrior) / avgPrior) * 100;
    if (deviationPct >= threshold && (maxDeviation === null || deviationPct > maxDeviation)) {
      maxDeviation = deviationPct;
    }
  }
  return maxDeviation;
}

async function evalLowCreditBalance(db: DB, companyId: string, threshold: number): Promise<number | null> {
  const balance = await getCreditBalance(db, companyId);
  // CU-868kfvafy criterio 1: configurable desde el panel (platform_settings), nunca
  // en código — creditsConfig.monthlyAllotment queda solo como fallback si el admin
  // nunca lo tocó (entorno recién migrado, sin seed).
  const monthlyAllotment = await getPlatformSetting(
    db,
    SETTINGS_KEYS.creditMonthlyAllotment,
    creditsConfig.monthlyAllotment,
  );
  const pctRemaining = (balance / monthlyAllotment) * 100;
  return pctRemaining < threshold ? pctRemaining : null;
}

const EVALUATORS: Record<string, (db: DB, companyId: string, threshold: number) => Promise<number | null>> = {
  ar_overdue: evalArOverdue,
  portfolio_concentration: evalPortfolioConcentration,
  revenue_drop: evalRevenueDrop,
  margin_drop: evalMarginDrop,
  spend_out_of_range: evalSpendOutOfRange,
  low_credit_balance: evalLowCreditBalance,
};

/**
 * CU-868kfvad3: motor determinista (sin IA), catálogo fijo, umbrales por empresa.
 * Llamado tras cada job de Excel exitoso (criterio 2). Historial completo en
 * alert_events (criterio 3) — incluso las que no notifican por el control de
 * repetición de 7 días (alert-catalog.ts), a diferencia de las que sí envían email.
 */
export async function evaluateAlerts(db: DB, companyId: string, documentId?: string): Promise<void> {
  const rules = await db
    .select()
    .from(alertRules)
    .where(and(eq(alertRules.companyId, companyId), eq(alertRules.enabled, true)));

  const [company] = await db
    .select({ locale: companies.locale })
    .from(companies)
    .where(eq(companies.id, companyId));
  const locale = company?.locale ?? 'es';

  for (const rule of rules) {
    const evaluator = EVALUATORS[rule.ruleKey];
    if (!evaluator) continue;

    const triggeredValue = await evaluator(db, companyId, Number(rule.threshold));
    if (triggeredValue === null) continue;

    const sevenDaysAgo = new Date(Date.now() - NO_REPEAT_DAYS * 86_400_000);
    const [recent] = await db
      .select({ id: alertEvents.id })
      .from(alertEvents)
      .where(
        and(
          eq(alertEvents.companyId, companyId),
          eq(alertEvents.alertRuleId, rule.id),
          gte(alertEvents.createdAt, sevenDaysAgo),
        ),
      )
      .limit(1);

    const [event] = await db
      .insert(alertEvents)
      .values({ companyId, alertRuleId: rule.id, triggeredValue: String(triggeredValue), documentId })
      .returning();

    if (recent || !rule.notifyImmediately) continue; // suppressed by repeat window, or batched into the periodic report instead

    const catalogEntry = alertCatalog.find((c) => c.ruleKey === rule.ruleKey);
    const recipients = await db
      .select({ email: users.email })
      .from(companyUsers)
      .innerJoin(users, eq(users.id, companyUsers.userId))
      .where(
        and(
          eq(companyUsers.companyId, companyId),
          eq(companyUsers.status, 'active'),
          eq(companyUsers.receivesReports, true),
        ),
      );

    for (const recipient of recipients) {
      await sendAlertTriggeredEmail({
        companyId,
        locale,
        alertEventId: event!.id,
        ruleLabel: catalogEntry?.label ?? rule.ruleKey,
        recipientEmail: recipient.email,
        viewUrl: `${env.appBaseUrl}/alerts/${event!.id}`,
      });
    }
  }
}
