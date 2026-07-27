import type Anthropic from '@anthropic-ai/sdk';
import { and, asc, desc, eq, isNull, sql as rawSql } from 'drizzle-orm';
import type { DB } from '@/db/client';
import { chatSegments, chatMessages, aiUsageEvents } from '@/db/schema';
import { anthropicModel, assertZdrModel, getClient } from '@/lib/anthropic';
import { insertAiUsageEvent } from '@/lib/ai-usage';

// CU-868kfvabw: ~60% del presupuesto de contexto de claude-sonnet-5 (1M tokens,
// claude-api skill cache 2026-06-24) dispara la segmentación invisible. No es una
// cifra exacta de la API — es el umbral operativo que el ADR pide ("~60%").
const CONTEXT_WINDOW_TOKENS = 1_000_000;
const SEGMENT_THRESHOLD_TOKENS = CONTEXT_WINDOW_TOKENS * 0.6;

export async function getOrCreateActiveSegment(
  db: DB,
  companyId: string,
  chatId: string,
): Promise<{ id: string; seq: number }> {
  const [active] = await db
    .select({ id: chatSegments.id, seq: chatSegments.seq })
    .from(chatSegments)
    .where(and(eq(chatSegments.chatId, chatId), isNull(chatSegments.handoffDoc)))
    .orderBy(desc(chatSegments.seq))
    .limit(1);
  if (active) return active;

  const [lastClosed] = await db
    .select({ seq: chatSegments.seq })
    .from(chatSegments)
    .where(eq(chatSegments.chatId, chatId))
    .orderBy(desc(chatSegments.seq))
    .limit(1);

  const [created] = await db
    .insert(chatSegments)
    .values({ companyId, chatId, seq: (lastClosed?.seq ?? 0) + 1 })
    .returning({ id: chatSegments.id, seq: chatSegments.seq });
  return created!;
}

/**
 * Context sent to Claude for the next turn (criterio 2, "sin recorte"): handoff docs
 * of every closed segment, oldest first, folded into one synthetic user turn — plus
 * the raw user/assistant messages of the CURRENTLY active segment only. Older raw
 * messages are never replayed once their segment is closed; the handoff doc stands
 * in for them.
 */
export async function buildChatHistory(
  db: DB,
  chatId: string,
  activeSegmentId: string,
): Promise<Anthropic.MessageParam[]> {
  const closedSegments = await db
    .select({ seq: chatSegments.seq, handoffDoc: chatSegments.handoffDoc })
    .from(chatSegments)
    .where(and(eq(chatSegments.chatId, chatId), rawSql`${chatSegments.handoffDoc} IS NOT NULL`))
    .orderBy(asc(chatSegments.seq));

  const history: Anthropic.MessageParam[] = [];
  if (closedSegments.length > 0) {
    const summary = closedSegments.map((s) => `[Resumen segmento ${s.seq}]\n${s.handoffDoc}`).join('\n\n');
    history.push({
      role: 'user',
      content: `Contexto de la conversación hasta ahora (resumido, no literal):\n${summary}`,
    });
    history.push({ role: 'assistant', content: 'Entendido, tengo el contexto previo.' });
  }

  const activeMessages = await db
    .select({ role: chatMessages.role, content: chatMessages.content })
    .from(chatMessages)
    .where(eq(chatMessages.segmentId, activeSegmentId))
    .orderBy(asc(chatMessages.createdAt));

  for (const m of activeMessages) {
    if (m.role === 'tool') continue; // tool round-trips aren't persisted (ephemeral, per-turn only)
    history.push({ role: m.role, content: m.content });
  }

  return history;
}

async function segmentTokenTotal(db: DB, segmentId: string): Promise<number> {
  const [row] = await db
    .select({
      total: rawSql<string>`coalesce(sum(${aiUsageEvents.inputTokens} + ${aiUsageEvents.outputTokens}), 0)`,
    })
    .from(chatMessages)
    .innerJoin(aiUsageEvents, eq(aiUsageEvents.id, chatMessages.aiUsageEventId))
    .where(eq(chatMessages.segmentId, segmentId));
  return Number(row?.total ?? 0);
}

/**
 * Called after persisting a turn's messages. If the active segment is near the
 * context budget, writes an AI-generated handoff doc onto it (closing it) so the
 * NEXT turn's buildChatHistory() picks up the new segment instead of replaying raw
 * history — invisible to the user, no message is ever deleted or shown truncated.
 */
export async function maybeCloseSegment(
  db: DB,
  companyId: string,
  chatId: string,
  segmentId: string,
): Promise<void> {
  const tokens = await segmentTokenTotal(db, segmentId);
  if (tokens < SEGMENT_THRESHOLD_TOKENS) return;

  const messages = await db
    .select({ role: chatMessages.role, content: chatMessages.content })
    .from(chatMessages)
    .where(and(eq(chatMessages.segmentId, segmentId), rawSql`${chatMessages.role} != 'tool'`))
    .orderBy(asc(chatMessages.createdAt));

  assertZdrModel(anthropicModel);
  const transcript = messages.map((m) => `${m.role}: ${m.content}`).join('\n');
  const response = await getClient().messages.create({
    model: anthropicModel,
    max_tokens: 1024,
    system:
      'Resume esta conversación financiera en un documento de traspaso conciso, ' +
      'preservando cualquier dato/cifra/decisión relevante para continuar la ' +
      'conversación sin el historial crudo. No agregues opiniones nuevas.',
    messages: [{ role: 'user', content: transcript }],
  });
  const handoffDoc =
    response.content.find((b): b is Anthropic.TextBlock => b.type === 'text')?.text ?? '';

  await insertAiUsageEvent(db, {
    companyId,
    kind: 'chat',
    model: response.model,
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
  });

  await db.update(chatSegments).set({ handoffDoc }).where(eq(chatSegments.id, segmentId));
  await getOrCreateActiveSegment(db, companyId, chatId);
}
