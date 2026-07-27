import { Elysia, t } from 'elysia';
import { randomUUID } from 'node:crypto';
import { tenantDerive } from '@/guards/tenant.derive';
import { assertClientCapability } from '@/guards/require-capability';
import { getActiveCreditRule, getCreditBalance, estimateRequiredCredits, debitCredits } from '@/lib/credits';
import { generateInsightNarrative } from '@/lib/anthropic';
import { insertAiUsageEvent } from '@/lib/ai-usage';
import { getOrComputeMonthlyAmount, ROLLUP_TYPES } from '@/lib/rollups';
import { insightRequests } from '@/db/schema';

function monthStart(monthsAgo: number): string {
  const d = new Date();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() - monthsAgo);
  return d.toISOString().slice(0, 10);
}

/**
 * CU-868kfvabk. Hard block on insufficient credits (criterio 3): checked BEFORE any
 * AI call or row insert — no call, no consumption row, same pattern as the excel
 * intake's credit gate (src/modules/ingestion/index.ts).
 */
export const insights = new Elysia().use(tenantDerive).post(
  '/insights',
  async ({ companyId, userId, role, set, db }) => {
    assertClientCapability(role, 'view_dashboard_reports', set);

    const creditRule = await getActiveCreditRule(db, 'insight');
    if (creditRule) {
      const required = estimateRequiredCredits(creditRule, 1);
      const balance = await getCreditBalance(db, companyId);
      if (balance < required) {
        set.status = 402;
        return { error: 'insufficient_credits', required, balance };
      }
    }

    const months = Array.from({ length: 3 }, (_, i) => monthStart(2 - i));
    const snapshot: Record<string, Record<string, number>> = {};
    for (const period of months) {
      snapshot[period] = {};
      for (const type of ROLLUP_TYPES) {
        snapshot[period]![type] = await getOrComputeMonthlyAmount(db, companyId, period, type);
      }
    }

    const result = await generateInsightNarrative(snapshot);

    const insightRequestId = randomUUID();
    await insertAiUsageEvent(db, {
      companyId,
      kind: 'insight',
      refId: insightRequestId,
      model: result.model,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
    });
    if (creditRule) {
      await debitCredits(db, {
        companyId,
        actionKind: 'insight',
        credits: estimateRequiredCredits(creditRule, 1),
        creditRuleId: creditRule.id,
        refId: insightRequestId,
      });
    }
    await db.insert(insightRequests).values({
      id: insightRequestId,
      companyId,
      requestedBy: userId,
      promptSnapshot: JSON.stringify(snapshot),
      result: result.narrative,
    });

    const balanceAfter = await getCreditBalance(db, companyId);
    return { narrative: result.narrative, creditBalance: balanceAfter };
  },
  {
    response: {
      200: t.Object({ narrative: t.String(), creditBalance: t.Number() }),
      402: t.Object({
        error: t.Literal('insufficient_credits'),
        required: t.Number(),
        balance: t.Number(),
      }),
    },
  },
);

// CU-868kfvabk criterio 2: header shows the balance in CREDITS only — never tokens,
// never USD. This is the only field this route returns.
export const creditsBalance = new Elysia().use(tenantDerive).get(
  '/credits/balance',
  async ({ companyId, role, set, db }) => {
    assertClientCapability(role, 'view_dashboard_reports', set);
    const balance = await getCreditBalance(db, companyId);
    return { balance };
  },
  { response: t.Object({ balance: t.Number() }) },
);
