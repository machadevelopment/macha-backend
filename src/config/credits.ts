// Parámetro interno créditos↔tokens — CU-868kfv97x. Jose: nunca expuesto al usuario
// final (la unidad visible al cliente es el crédito); interno y ajustable sin
// desplegar código. Valor PLACEHOLDER "para que el sistema arranque" — Jose fue
// explícito en que no es una propuesta comercial; se recalibra con datos reales de
// costo durante las pruebas (ver ai_usage_events.billable_units / cost_usd).
export const creditsConfig = {
  /** Tokens (input+output) equivalentes a 1 crédito, para estimación de costo interna. */
  creditToTokensRatio: Number(process.env.CREDIT_TO_TOKENS_RATIO ?? 50_000),
};
