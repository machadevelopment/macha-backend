import { env } from './env';

/**
 * Anthropic Claude is the ONLY AI provider (signed ZDR contract). Never persist prompts
 * or customer financial data in the provider. Every call must insert one ai_usage_events
 * row (kind tagged). Re-verify ZDR eligibility on any model change. Initial: claude-sonnet-5.
 * Thin placeholder — real client wiring lands in a later feature ticket.
 */
export const anthropicModel = env.anthropicModel;
export function assertZdrModel(model: string): void {
  // Guard rail for future model upgrades.
  const zdrEligible = new Set(['claude-sonnet-5']);
  if (!zdrEligible.has(model)) throw new Error(`Model ${model} not verified for ZDR`);
}
