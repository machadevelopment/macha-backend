import { and, eq, desc, inArray, sql as rawSql } from 'drizzle-orm';
import type { DB } from '@/db/client';
import { creditRules, creditTransactions } from '@/db/schema';
import { creditsConfig } from '@/config/credits';
import { getPlatformSetting, SETTINGS_KEYS } from '@/lib/settings';

export type ActionKind = 'excel' | 'chat' | 'insight' | 'report_generation';

/**
 * El saldo NUNCA se lee de una columna materializada: es SUM(delta) sobre el ledger
 * append-only (data model §13, §4.20). Definido una sola vez para que la lectura de una
 * empresa y la de muchas no puedan divergir (ticket B5).
 */
const balanceSum = rawSql<string>`coalesce(sum(${creditTransactions.delta}), 0)`;

/** Saldo de créditos de UNA empresa. */
export async function getCreditBalance(db: DB, companyId: string): Promise<number> {
  const [row] = await db
    .select({ balance: balanceSum })
    .from(creditTransactions)
    .where(eq(creditTransactions.companyId, companyId));
  return Number(row?.balance ?? 0);
}

/**
 * Saldo de créditos de VARIAS empresas en una sola consulta (ticket B5).
 *
 * Existe por la vista consolidada del backoffice: llamar a `getCreditBalance` en un
 * bucle sobre la página de empresas son 50 viajes a la base para pintar una tabla, y
 * todos van por la MISMA conexión reservada del request (`admin.guard`), así que se
 * ejecutarían en serie.
 *
 * Una empresa sin ningún movimiento no aparece en el resultado del `GROUP BY`; el
 * llamador la interpreta como saldo 0, que es lo que significa un ledger vacío.
 */
export async function getCreditBalances(
  db: DB,
  companyIds: string[],
): Promise<Map<string, number>> {
  if (companyIds.length === 0) return new Map();
  const rows = await db
    .select({ companyId: creditTransactions.companyId, balance: balanceSum })
    .from(creditTransactions)
    .where(inArray(creditTransactions.companyId, companyIds))
    .groupBy(creditTransactions.companyId);
  return new Map(rows.map((r) => [r.companyId, Number(r.balance)]));
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

/**
 * Abono (o corrección) manual de créditos — CU-868kjc7g5 / US-19.
 *
 * `note` es obligatoria en la firma, no opcional: hasta este ticket las dos únicas
 * escrituras del ledger eran el débito por consumo y el abono de una compra de
 * Recurrente, ambas con su origen implícito (`ref_id`). Un movimiento hecho a mano no
 * tiene origen que lo explique, así que la razón ES el registro.
 *
 * `delta` puede ser negativo a propósito: `credit_transactions` es append-only (REVOKE
 * UPDATE, DELETE en 0010), así que revertir un abono equivocado es una FILA
 * COMPENSATORIA con su propia nota, nunca un UPDATE. El endpoint no ofrece editar.
 */
export async function recordCreditAdjustment(
  db: DB,
  params: {
    companyId: string;
    delta: number;
    reason: 'monthly_allotment' | 'top_up';
    note: string;
    createdBy?: string;
  },
): Promise<{ id: string }> {
  const [row] = await db
    .insert(creditTransactions)
    .values({
      companyId: params.companyId,
      delta: Math.round(params.delta),
      reason: params.reason,
      note: params.note,
      createdBy: params.createdBy,
    })
    .returning({ id: creditTransactions.id });
  return { id: row!.id };
}

/**
 * Créditos de arranque de una empresa nueva (CU-868kjc7g5 criterio 3). El valor sale de
 * `platform_settings` para poder cambiarlo sin desplegar; `creditsConfig` solo actúa de
 * fallback en un entorno recién migrado y sin seed.
 *
 * Se llama al final del alta (registro autoservicio y alta manual del admin), dentro de
 * la misma transacción: una empresa que nace sin créditos es una empresa que no puede
 * pedir su primer insight y que además dispara la alerta de saldo bajo desde el día uno.
 *
 * ASIGNACIÓN MENSUAL RECURRENTE: NO en v1 (criterio 6). Un job que acredita a todas las
 * empresas cada mes necesita una política de reseteo/rollover —¿el saldo no usado se
 * pierde, se acumula, se topa?— y esa es justo la decisión que sigue abierta en PRD §12
 * punto 4. Mientras tanto: abono inicial automático + top-up manual de super_admin, que
 * son mecanismo puro y no comprometen ninguna de las respuestas posibles.
 */
export async function grantInitialCredits(
  db: DB,
  companyId: string,
  /**
   * Créditos que trae el PLAN elegido (ticket B3, 2026-08-11). Es lo que el ticket pedía
   * con "los créditos del plan alimentan la asignación del motor existente".
   *
   * Cuando viene, MANDA sobre `platform_settings.credit_initial_grant`, y el orden importa:
   * si el ajuste global ganara, elegir Enterprise en vez de Starter no cambiaría nada y el
   * catálogo de planes sería decorativo. El setting global queda como lo que siempre fue —
   * el valor para quien no tiene plan con créditos declarados, que hoy es toda empresa en
   * el plan histórico `base` (la migración 0021 lo dio de alta con 0 créditos justamente
   * para no cambiarle el comportamiento a nadie).
   *
   * SIGUE SIN HABER ASIGNACIÓN MENSUAL RECURRENTE. Este es el abono INICIAL. El motor
   * mensual no entró en v1 (criterio 6 de CU-868kjc7g5) porque necesita la política de
   * reseteo/rollover que sigue abierta en PRD §12 punto 4, y el catálogo de planes no la
   * responde: saber cuántos créditos trae Enterprise no dice qué pasa con los que sobraron
   * de agosto.
   */
  planMonthlyCredits?: number | null,
): Promise<{ granted: number }> {
  const amount =
    planMonthlyCredits && planMonthlyCredits > 0
      ? planMonthlyCredits
      : Number(
          await getPlatformSetting(
            db,
            SETTINGS_KEYS.creditInitialGrant,
            creditsConfig.monthlyAllotment,
          ),
        );
  if (!Number.isFinite(amount) || amount <= 0) return { granted: 0 };

  await recordCreditAdjustment(db, {
    companyId,
    delta: amount,
    reason: 'monthly_allotment',
    note: 'Asignación inicial al dar de alta la empresa',
  });
  return { granted: amount };
}
