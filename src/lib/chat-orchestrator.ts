import type Anthropic from '@anthropic-ai/sdk';
import { anthropicModel, assertZdrModel, getClient } from '@/lib/anthropic';
import { runAi } from '@/lib/ai-errors';
import { CHAT_TOOLS, executeChatTool, type ChatToolContext } from '@/lib/chat-tools';
import { insertAiUsageEvent } from '@/lib/ai-usage';

function systemPrompt(locale: 'es' | 'en'): string {
  const languageLine =
    locale === 'es'
      ? 'Responde SIEMPRE en español, sin importar el idioma del mensaje del usuario.'
      : 'ALWAYS respond in English, regardless of the language of the user message.';
  return `Eres el asistente financiero (CFO) de Macha Finance para una PYME. Usas
herramientas para consultar datos estructurados (nunca inventes cifras). Empieza por
la narrativa del último reporte si existe, luego profundiza por rollups mensuales, y
solo como último recurso consulta transacciones individuales. ${languageLine}`;
}

export interface ChatTurnResult {
  assistantText: string;
  totalInputTokens: number;
  totalOutputTokens: number;
  callCount: number;
}

/**
 * CU-868kfvabq: un turno completo (posiblemente varias llamadas a Claude por los
 * round-trips de tool-use). Cada llamada individual inserta su propia fila en
 * ai_usage_events (kind=chat) — criterio 3 del ticket ("cada llamada", no "cada
 * turno"). `history` ya viene acotado por el llamador (chat-segments.ts): handoff
 * docs de segmentos cerrados + mensajes crudos solo del segmento activo.
 */
export async function runChatTurn(params: {
  db: Pick<ChatToolContext, 'db'>['db'];
  companyId: string;
  locale: 'es' | 'en';
  history: Anthropic.MessageParam[];
  userMessage: string;
}): Promise<ChatTurnResult> {
  assertZdrModel(anthropicModel);
  const anthropic = getClient();
  const toolCtx: ChatToolContext = { db: params.db, companyId: params.companyId };

  const messages: Anthropic.MessageParam[] = [
    ...params.history,
    { role: 'user', content: params.userMessage },
  ];

  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let callCount = 0;

  // Bounded loop: a runaway tool-use cycle should never hang a request indefinitely.
  for (let round = 0; round < 8; round++) {
    const response = await runAi('chat_turn', () =>
      anthropic.messages.create({
        model: anthropicModel,
        max_tokens: 2048,
        system: systemPrompt(params.locale),
        tools: CHAT_TOOLS,
        messages,
      }),
    );

    callCount++;
    totalInputTokens += response.usage.input_tokens;
    totalOutputTokens += response.usage.output_tokens;
    await insertAiUsageEvent(params.db, {
      companyId: params.companyId,
      kind: 'chat',
      model: response.model,
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
    });

    if (response.stop_reason !== 'tool_use') {
      const textBlock = response.content.find((b): b is Anthropic.TextBlock => b.type === 'text');
      return {
        assistantText: textBlock?.text ?? '',
        totalInputTokens,
        totalOutputTokens,
        callCount,
      };
    }

    messages.push({ role: 'assistant', content: response.content });

    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const block of response.content) {
      if (block.type !== 'tool_use') continue;
      const result = await executeChatTool(toolCtx, block.name, block.input);
      toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: result });
    }
    messages.push({ role: 'user', content: toolResults });
  }

  throw new Error('Chat turn exceeded max tool-use rounds without a final answer');
}
