import { directivaDeEmpresa } from '@/lib/insight-directives';
import type Anthropic from '@anthropic-ai/sdk';
import { anthropicModel, assertZdrModel, getClient } from '@/lib/anthropic';
import { AiProviderError, runAi } from '@/lib/ai-errors';
import { CHAT_TOOLS, executeChatTool, type ChatToolContext } from '@/lib/chat-tools';
import { insertAiUsageEvent } from '@/lib/ai-usage';

/**
 * Prompt de sistema del asesor.
 *
 * CU-868knx181, causa 2. Hasta esta versión el prompt decía QUÉ consultar y en qué orden,
 * pero no decía NADA sobre cómo escribir. El resultado, visto en la ronda de QA: respuestas
 * larguísimas, que arrancaban recapitulando la pregunta, con tablas gigantes para tres
 * cifras y listados mes por mes incluyendo los meses en cero. La causa 1 (que el frontend
 * no renderizaba Markdown) ya se arregló; esto es lo otro.
 *
 * DOS COSAS QUE EL PROMPT AHORA SÍ DICE, y por qué cada una:
 *
 *   · **El formato se renderiza.** Antes daba igual lo que el modelo emitiera, porque
 *     salía como texto plano de todos modos. Ahora que hay Markdown, decirle que las
 *     tablas se ven de verdad cambia cuándo le conviene usarlas — y hay que ponerle techo,
 *     porque una tabla de doce meses no cabe en una burbuja de chat en móvil.
 *   · **Los períodos en cero se resumen.** Es el caso concreto que más ruido generaba: una
 *     PYME que cargó tres meses de datos recibía doce filas, nueve de ellas en 0. La
 *     información útil ahí es "solo hay datos desde mayo", una línea.
 *
 * LO QUE NO SE TOCA: la regla de no inventar cifras y el orden de consulta (reporte →
 * rollups → transacciones). Son de correctitud, no de estilo, y estaban bien.
 *
 * El prompt está en español porque es instrucción para el modelo, no texto de usuario;
 * `languageLine` es lo único que decide el idioma de la RESPUESTA.
 */
function systemPrompt(locale: 'es' | 'en', companyName?: string | null): string {
  // CU-868kt984z: el nombre de la empresa del cliente. Sin él, el único nombre propio del
  // prompt es "Macha Finance" y el modelo lo usa como sujeto ("Macha Finance registró
  // ingresos por…"). Se anexa al final, como el resto de las reglas de escritura.
  const directiva = directivaDeEmpresa({ locale, companyName });
  const empresa = directiva ? `\n- ${directiva}` : '';
  const languageLine =
    locale === 'es'
      ? 'Responde SIEMPRE en español, sin importar el idioma del mensaje del usuario.'
      : 'ALWAYS respond in English, regardless of the language of the user message.';
  return `Eres el asistente financiero (CFO) de Macha Finance para una PYME. Usas
herramientas para consultar datos estructurados (nunca inventes cifras). Empieza por
la narrativa del último reporte si existe, luego profundiza por rollups mensuales, y
solo como último recurso consulta transacciones individuales. ${languageLine}

Hablas con el dueño de un negocio, no con un analista. Escribe así:

- EMPIEZA POR LA RESPUESTA. La primera frase contesta lo que te preguntaron, con la cifra
  si la hay. Nada de recapitular la pregunta ni de anunciar lo que vas a hacer.
- SÉ BREVE. Apunta a menos de 150 palabras. Si el tema da para más, di lo esencial y
  ofrece profundizar.
- Frases cortas y listas de pocos puntos ANTES que tablas. Usa una tabla solo cuando
  compares 3 o más cosas por 2 o más columnas, y no pases de 6 filas: tu respuesta se
  renderiza como Markdown en un chat angosto, también en móvil.
- Los períodos SIN movimiento se resumen en una frase ("solo hay datos desde mayo"), nunca
  se listan uno por uno en cero.
- Negrita solo para la cifra o el hallazgo clave, no para media respuesta.
- Cierra con UNA sola pregunta de seguimiento, o con ninguna. Nunca con varias.
- Si los datos no alcanzan para responder, dilo en una frase y di qué falta cargar.${empresa}`;
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
  /** CU-868kt984z. Opcional: sin él el prompt queda como antes, no se rompe el llamador. */
  companyName?: string | null;
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
        system: systemPrompt(params.locale, params.companyName),
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
      cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
      cacheCreationTokens: response.usage.cache_creation_input_tokens ?? 0,
    });

    if (response.stop_reason !== 'tool_use') {
      const textBlock = response.content.find((b): b is Anthropic.TextBlock => b.type === 'text');

      /*
       * ═══ "EL ASESOR NO RESPONDE" (CU-868krw2gx) ═══
       *
       * Acá estaba el `?? ''`, y era literalmente el bug reportado. Si el mensaje final no
       * traía bloque de texto, o traía uno vacío, esta función devolvía **cadena vacía con
       * toda normalidad**: el endpoint respondía 200, guardaba un mensaje de asistente
       * vacío en `chat_messages`, y el usuario veía una burbuja en blanco. Sin error, sin
       * reintento, sin nada que indicara que algo había fallado.
       *
       * Y empeoraba solo: el mensaje vacío queda en el historial, así que la siguiente
       * pregunta se manda con un turno degenerado adentro. Eso explica el "tras dar 2
       * prompts más, ni siquiera devuelve una respuesta".
       *
       * `stop_reason === 'max_tokens'` va en la MISMA condición aunque sí haya texto: es
       * una respuesta cortada a mitad de frase, y para el que la lee eso no es una
       * respuesta. Es el mismo fallo que trunca los reportes (CU-868krw2wn), en la otra
       * superficie donde el modelo escribe para el cliente.
       *
       * Se lanza el error de dominio que ya existe en vez de devolver vacío: el endpoint lo
       * traduce a un status y a un mensaje presentable, el frontend ya sabe mostrar ese
       * error (`sendError` en chat-client.tsx), y —clave— el turno NO se guarda, así que
       * reintentar parte del mismo estado y no de uno contaminado.
       */
      if (response.stop_reason === 'max_tokens' || !textBlock || textBlock.text.trim() === '') {
        throw new AiProviderError('incomplete', 'chat_turn', {
          cause: new Error(
            `stop_reason=${response.stop_reason} ronda=${round} texto=${textBlock?.text.length ?? 0} chars`,
          ),
        });
      }

      return {
        assistantText: textBlock.text,
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

  /*
   * Agotar las 8 rondas también es una respuesta que nunca llegó, así que sale por el mismo
   * camino que los otros dos casos. Antes era un `Error` pelado: 500 sin cuerpo útil, que
   * en la pantalla del cliente se ve igual que el silencio.
   */
  throw new AiProviderError('incomplete', 'chat_turn', {
    cause: new Error('el turno agotó las 8 rondas de tool-use sin producir una respuesta'),
  });
}
