import type { DB } from '@/db/client';
import { aiUsageEvents } from '@/db/schema';
import { estimateCostUsd } from './anthropic';

/**
 * Inserts one ai_usage_events row per Claude call (CLAUDE.md non-negotiable: "Every
 * Claude call inserts one ai_usage_events row tagged kind"). No prompts or customer
 * data are persisted here — only consumption metadata (ZDR).
 */
export async function insertAiUsageEvent(
  db: DB,
  params: {
    companyId: string;
    kind: 'excel' | 'chat' | 'insight' | 'report_generation' | 'excel_correction';
    refId?: string;
    model: string;
    inputTokens: number;
    outputTokens: number;
    billableUnits?: number;
  },
): Promise<void> {
  await db.insert(aiUsageEvents).values({
    companyId: params.companyId,
    kind: params.kind,
    refId: params.refId,
    model: params.model,
    inputTokens: params.inputTokens,
    outputTokens: params.outputTokens,
    costUsd: estimateCostUsd(params.inputTokens, params.outputTokens).toFixed(6),
    billableUnits: params.billableUnits,
  });
}
