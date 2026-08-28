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
import {
  directivaDeEmpresa,
  directivaDeEscritura,
  directivaDeIdioma,
} from '@/lib/insight-directives';
import { localeDeContenido } from '@/lib/content-locale';
import { insightRequests, companies } from '@/db/schema';
import { enforceTokenBucket, rateLimitedResponse } from '@/lib/rate-limit';
import { withCompanyScope } from '@/lib/db-scope';
import { cerrarPendiente } from '@/guards/liberar-conexion';
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
  async ({ companyId, userId, role, set, db, request }) => {
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

    const [company] = await db
      // CU-868kt984z: el NOMBRE viaja junto a la moneda. Sin él, el único nombre propio
      // del contexto es "Macha Finance" y el modelo lo toma como sujeto (ver el bug en
      // `directivaDeEmpresa`). Es la misma consulta, una columna más.
      .select({ baseCurrency: companies.baseCurrency, name: companies.name })
      .from(companies)
      .where(eq(companies.id, companyId));
    const baseCurrency = company?.baseCurrency ?? 'GTQ';

    const months = Array.from({ length: 3 }, (_, i) => monthStart(2 - i));
    const porPeriodo: Record<string, Record<string, number>> = {};
    for (const period of months) {
      porPeriodo[period] = {};
      for (const type of ROLLUP_TYPES) {
        porPeriodo[period]![type] = await getOrComputeMonthlyAmount(db, companyId, period, type);
      }
    }

    /*
     * CU-868krvtjw: la MONEDA viaja en el snapshot.
     *
     * Antes eran tres meses de números crudos y nada más — ni un campo que dijera si son
     * quetzales o dólares. Pedirle al modelo que escriba el símbolo sin darle el dato lo
     * obligaría a adivinar la moneda de las cifras de una empresa, que es de los pocos
     * errores que este producto no puede permitirse.
     *
     * Los montos quedan bajo `amounts` en vez de en la raíz: un campo suelto al lado de las
     * claves de período (`2026-06-01`, …) se lee como un período más y el modelo podría
     * narrarlo como si fuera un mes.
     */
    const snapshot = { baseCurrency, amounts: porPeriodo };

    // CU-868kfvafy: prompt editable por super_admin (platform_settings), no
    // hardcodeado — insight_requests.prompt_snapshot congela el que se usó.
    const promptTemplate = await getPlatformSetting(
      db,
      SETTINGS_KEYS.insightPromptTemplate,
      DEFAULT_INSIGHT_PROMPT,
    );
    /*
     * CU-868kfvam8 (i18n transversal): la IA debe respetar el idioma. El template guardado
     * en `platform_settings` es un solo texto —no localizado por diseño, un admin lo edita
     * una vez— así que las directivas se agregan DESPUÉS, y por eso valen sin importar lo
     * que ese admin haya escrito ahí. Escribirlas dentro de `DEFAULT_INSIGHT_PROMPT` no
     * llegaría a producción: ese texto es solo el respaldo para entornos sin la fila.
     *
     * CU-868krvuct: el idioma pasa a ser el de QUIEN PIDIÓ el insight, no el de la empresa.
     * El chat y los reportes a demanda ya se corrigieron; los insights se habían quedado
     * leyendo `companies.locale`, que se fija en el registro y no se puede editar desde
     * ninguna pantalla. Los tres caminos de IA usan ahora el mismo resolvedor.
     *
     * CU-868krvtjw: y la directiva de escritura —símbolo de moneda, sin decimales, empezar
     * por el hallazgo— viaja por el mismo carril, por la misma razón.
     */
    const locale = await localeDeContenido(db, companyId, userId);
    const localizedPrompt = [
      promptTemplate,
      directivaDeIdioma(locale),
      directivaDeEscritura({ locale, baseCurrency }),
      directivaDeEmpresa({ locale, companyName: company?.name }),
    ]
      // `directivaDeEmpresa` devuelve `null` si la empresa no tiene nombre: mejor sin
      // directiva que pidiéndole al modelo llamar "" a la empresa.
      .filter(Boolean)
      .join('\n\n');

    /*
     * ═══ LA CONEXIÓN NO PUEDE QUEDARSE ABIERTA MIENTRAS CLAUDE ESCRIBE ═══
     *
     * El worker de Excel ya lo hace: transacciones cortas, llamada al modelo FUERA.
     * `POST /insights` no. El guard reserva una transacción al entrar y la deja
     * idle durante toda la espera a Anthropic. En producción (2026-08-28) el
     * watchdog la recogía a los 90 s — exactamente el techo del botón — con origen
     * `POST /insights`, y el panel caía a "no pudimos generar el insight".
     *
     * Commit ahora: hasta acá solo se LEYÓ. `onAfterHandle`/`onError` son no-ops
     * porque `cerrarPendiente` ya sacó la entrada. Claude corre sin transacción.
     * Las escrituras van en una transacción nueva, igual que el worker.
     */
    await cerrarPendiente(request, true);
    const result = await generateInsightNarrative(snapshot, localizedPrompt, request.signal);

    const insightRequestId = randomUUID();
    const balanceAfter = await withCompanyScope(companyId, async (db) => {
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
      return getCreditBalance(db, companyId);
    });
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
              t.Literal('cashflow'),
              t.Literal('revenue'),
              t.Literal('expenses'),
              t.Literal('collections'),
              // Alias que el parser aún puede devolver si alguien salta el mapeo:
              // `insight_requests` es append-only y el panel pinta estas dos de
              // antes de CU-868kx7a73. No se le ofrecen al modelo.
              t.Literal('financial'),
              t.Literal('sales'),
            ]),
            text: t.String(),
            severity: t.Optional(
              t.Union([t.Literal('critical'), t.Literal('warning'), t.Literal('info')]),
            ),
            action: t.Optional(t.String()),
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
