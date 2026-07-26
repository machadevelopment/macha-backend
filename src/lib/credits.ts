import { and, eq, desc, sql as rawSql } from 'drizzle-orm';
import type { DB } from '@/db/client';
import { creditRules, creditTransactions } from '@/db/schema';

export type ActionKind = 'excel' | 'chat' | 'insight' | 'report_generation';

/** Saldo de créditos por empresa = SUM(delta) (data model §13, §4.20). */
export async function getCreditBalance(db: DB, companyId: string): Promise<number> {
  const [row] = await db
    .select({ balance: rawSql<string>`coalesce(sum(${creditTransactions.delta}), 0)` })
    .from(creditTransactions)
    .where(eq(creditTransactions.companyId, companyId));
  return Number(row?.balance ?? 0);
}

/** Versión activa más reciente de la regla para una acción (CU-868kfv97x, §4.19a). */
export async function getActiveCreditRule(
  db: DB,
  actionKind: ActionKind,
): Promise<typeof creditRules.$inferSelect | null> {
  const [rule] = await db
    .select()
    .from(creditRules)
    .where(and(eq(creditRules.actionKind, actionKind), eq(creditRules.active, true)))
    .orderBy(desc(creditRules.version))
    .limit(1);
  return rule ?? null;
}

/** Créditos requeridos según el tipo de regla: fija = valor único; variable = valor × unidades. */
export function estimateRequiredCredits(
  rule: Pick<typeof creditRules.$inferSelect, 'ruleType' | 'creditsPerUnit'>,
  unitCount: number,
): number {
  const perUnit = Number(rule.creditsPerUnit);
  return rule.ruleType === 'variable' ? perUnit * unitCount : perUnit;
}

/**
 * Débito de créditos (CU-868kfvaa6, append-only). `refId` es el objeto origen
 * (document_id/chat_id/report_id/insight_requests.id según action_kind).
 */
export async function debitCredits(
  db: DB,
  params: {
    companyId: string;
    actionKind: ActionKind;
    credits: number;
    creditRuleId: string;
    refId: string;
  },
): Promise<void> {
  // credit_transactions.delta is an integer column (data model §4.20) — fractional
  // creditsPerUnit rounds here. Not an issue with today's whole-number provisional
  // rules (scripts/seed.ts); revisit if a future rule version goes fractional.
  await db.insert(creditTransactions).values({
    companyId: params.companyId,
    delta: -Math.round(params.credits),
    reason: 'consumption',
    actionKind: params.actionKind,
    creditRuleId: params.creditRuleId,
    refId: params.refId,
  });
}
