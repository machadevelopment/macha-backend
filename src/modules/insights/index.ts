import { Elysia, t } from 'elysia';
import { randomUUID } from 'node:crypto';
import { tenantDerive } from '@/guards/tenant.derive';
import { assertClientCapability } from '@/guards/require-capability';
import {
  getActiveCreditRule,
  getCreditBalance,
  estimateRequiredCredits,
  debitCredits,
} from '@/lib/credits';
import { generateInsightNarrative, DEFAULT_INSIGHT_PROMPT } from '@/lib/anthropic';
import { insertAiUsageEvent } from '@/lib/ai-usage';
import { getOrComputeMonthlyAmount, ROLLUP_TYPES } from '@/lib/rollups';
import { getPlatformSetting, SETTINGS_KEYS } from '@/lib/settings';
import { insightRequests } from '@/db/schema';
import { checkTokenBucket } from '@/lib/rate-limit';

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

    // CU-868kfvaah: 'ai' token-bucket — ver nota equivalente en modules/chats/index.ts.
    const gate = await checkTokenBucket('ai', companyId);
    if (!gate.allowed) {
      set.status = 429;
      set.headers['Retry-After'] = String(gate.retryAfterSeconds);
      return { error: 'rate_limited', retryAfterSeconds: gate.retryAfterSeconds };
    }

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

    // CU-868kfvafy: prompt editable por super_admin (platform_settings), no
    // hardcodeado — insight_requests.prompt_snapshot congela el que se usó.
    const promptTemplate = await getPlatformSetting(
      db,
      SETTINGS_KEYS.insightPromptTemplate,
      DEFAULT_INSIGHT_PROMPT,
    );
    const result = await generateInsightNarrative(snapshot, promptTemplate);

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
      // data model.md §4.21: el texto del PROMPT (congelado), no los datos de
      // entrada — corregido de una versión anterior que guardaba el snapshot de
      // métricas aquí por error. Ahora que el prompt es editable (platform_settings),
      // esto es lo que de verdad puede cambiar entre requests y necesita congelarse.
      promptSnapshot: promptTemplate,
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
      429: t.Object({
        error: t.Literal('rate_limited'),
        retryAfterSeconds: t.Number(),
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
