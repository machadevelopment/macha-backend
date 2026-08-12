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
import { insightRequests, companies } from '@/db/schema';
import { enforceTokenBucket, rateLimitedResponse } from '@/lib/rate-limit';
import { eq } from 'drizzle-orm';

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
    // CU-868kh92fz: el rechazo ahora se reporta a Sentry dentro de enforceTokenBucket.
    const limited = await enforceTokenBucket('ai', companyId, set, 'POST /insights');
    if (limited) return limited;

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
    // CU-868kfvam8 (i18n transversal): la IA debe respetar el idioma de la empresa —
    // chat (chat-orchestrator) y reportes (reports.ts) ya lo hacían, insight se había
    // quedado con un prompt fijo en español sin importar companies.locale. El template
    // guardado en platform_settings es un solo texto (no localizado por diseño, un
    // admin lo edita una vez) — la instrucción de idioma se agrega aparte, después del
    // template, para que valga sin importar lo que el admin haya escrito ahí.
    const [company] = await db
      .select({ locale: companies.locale })
      .from(companies)
      .where(eq(companies.id, companyId));
    const locale = company?.locale ?? 'es';
    const localizedPrompt = `${promptTemplate}\n\n${
      locale === 'en' ? 'Respond in English.' : 'Responde en español.'
    }`;
    const result = await generateInsightNarrative(snapshot, localizedPrompt);

    const insightRequestId = randomUUID();
    await insertAiUsageEvent(db, {
      companyId,
      kind: 'insight',
      refId: insightRequestId,
      model: result.model,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      cacheReadTokens: result.cacheReadTokens,
      cacheCreationTokens: result.cacheCreationTokens,
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
      promptSnapshot: localizedPrompt,
      result: result.narrative,
    });

    const balanceAfter = await getCreditBalance(db, companyId);
    /*
     * `insights` se suma; `narrative` se CONSERVA. No es redundancia: el frontend degrada a
     * `narrative` cuando el modelo no llamó a la herramienta y la lista viene vacía, y así
     * este cambio no rompe a ningún consumidor que ya lea el texto.
     */
    return { insights: result.insights, narrative: result.narrative, creditBalance: balanceAfter };
  },
  {
    response: {
      200: t.Object({
        insights: t.Array(
          t.Object({
            // Literales escritos a mano y no `INSIGHT_CATEGORIES.map(t.Literal)`: mapear
            // una tupla `as const` colapsa el union a `never` en la inferencia de Elysia y
            // el handler deja de encajar con su propio esquema de respuesta. El enum sigue
            // siendo la fuente de verdad en `lib/anthropic.ts`; si crece, esto también.
            category: t.Union([
              t.Literal('collections'),
              t.Literal('sales'),
              t.Literal('financial'),
            ]),
            text: t.String(),
          }),
        ),
        narrative: t.String(),
        creditBalance: t.Number(),
      }),
      402: t.Object({
        error: t.Literal('insufficient_credits'),
        required: t.Number(),
        balance: t.Number(),
      }),
      429: rateLimitedResponse,
    },
  },
);

// CU-868kfvabk criterio 2: header shows the balance in CREDITS only — never tokens,
// never USD. This is the only field this route returns.
export const creditsBalance = new Elysia().use(tenantDerive).get(
  '/credits/balance',
  async ({ companyId, role, set, db }) => {
    assertClientCapability(role, 'view_dashboard_reports', set);

    // CU-868kh8qhp: bucket `read`. El header lo consulta en cada pantalla, así que es
    // de los endpoints con más tráfico por sesión.
    const limited = await enforceTokenBucket('read', companyId, set, 'GET /credits/balance');
    if (limited) return limited;

    const balance = await getCreditBalance(db, companyId);
    return { balance };
  },
  {
    response: {
      200: t.Object({ balance: t.Number() }),
      429: rateLimitedResponse,
    },
  },
);
