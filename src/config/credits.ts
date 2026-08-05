// Parámetros de créditos — CU-868kfv97x, decisión final de Jose. Valores
// PROVISIONALES "para que el sistema arranque", holgados a propósito para no
// contaminar la medición durante las pruebas — no son propuesta comercial. Se
// recalibran con datos reales de costo (ver ai_usage_events.billable_units / cost_usd).
// Las reglas por acción (excel/chat/insight/report_generation) viven en `credit_rules`
// (sembradas en scripts/seed.ts), no aquí — esto es lo que no tiene tabla propia.
export const creditsConfig = {
  /** Tokens (input+output) equivalentes a 1 crédito, para estimación de costo interna.
   * Nunca expuesto al usuario final (la unidad visible al cliente es el crédito). */
  creditToTokensRatio: Number(process.env.CREDIT_TO_TOKENS_RATIO || 50_000),
  /** Asignación mensual provisional de créditos por empresa (paquete del plan).
   * Sin endpoint de onboarding todavía que la aplique (F7/M8); documentado aquí para
   * cuando exista. */
  monthlyAllotment: Number(process.env.CREDIT_MONTHLY_ALLOTMENT || 1_000),
};
