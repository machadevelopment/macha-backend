import { describe, expect, test, mock, beforeEach } from 'bun:test';
import { AiProviderError } from '@/lib/ai-errors';

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════
 * UNA RESPUESTA CORTADA O VACÍA NO ES UNA RESPUESTA
 * CU-868krw2wn (reportes a medias) · CU-868krw2gx (el asesor no responde)
 * CU-868ktm2m2 (el consejo diario devuelve error, sin decir por qué)
 * ═══════════════════════════════════════════════════════════════════════════════════════
 *
 * Macha reportó dos cosas que parecían distintas:
 *
 *   · *"al generar un reporte, sale incompleto, como si se hubiera quedado a medias"*
 *   · *"una pregunta simple no la contesta, y tras dar 2 prompts más, ni siquiera devuelve
 *     una respuesta"*
 *
 * Son el MISMO fallo en las dos superficies donde el modelo escribe para el cliente: la
 * llamada sale bien —200, sin excepción— y aun así no produce texto usable. El único
 * indicio es `stop_reason`, y nadie lo miraba. Lo que había en su lugar:
 *
 *   · en el reporte, `textBlock.text` se tomaba tal cual;
 *   · en el chat, `assistantText: textBlock?.text ?? ''`, que convertía "no hubo respuesta"
 *     en una cadena vacía perfectamente válida.
 *
 * Y las consecuencias no eran simétricas: la narrativa cortada se subía a S3, se insertaba
 * en `report_versions` —que es APPEND-ONLY, así que **ya no se podía corregir ni borrar**— y
 * se mandaba por correo. La respuesta vacía del chat se guardaba en el historial, así que el
 * turno siguiente arrancaba contaminado: de ahí el "tras 2 prompts más".
 *
 * ═══ POR QUÉ LOS DOS EN UN SOLO ARCHIVO ═══
 *
 * Porque `mock.module` de Bun es GLOBAL al proceso, y `bun test src` corre todos los
 * unitarios en uno. Dos archivos fingiendo el mismo SDK se pisan entre sí (y fingir
 * `@/lib/anthropic` rompía además `anthropic.test.ts`, que prueba el módulo de verdad).
 * Un solo doble del SDK, acá, cubre las dos superficies sin tocar a nadie más.
 *
 * Del resto NO se finge nada: el orquestador usa las herramientas de verdad —con un `db`
 * que lanza, que es justo el escenario— y `insertAiUsageEvent` real contra un `db` mudo.
 * Fingir `@/lib/chat-tools` habría roto `chat-tools-fallo.test.ts`, y de paso habría dejado
 * sin ejercer el camino que se quiere probar.
 */

interface RespuestaFingida {
  stop_reason: string;
  content: unknown[];
}

let respuestas: RespuestaFingida[] = [];
let llamadas = 0;
let maxTokensPedido = 0;
let mensajesDeLaUltimaLlamada: unknown[] = [];

const siguiente = (): RespuestaFingida => {
  const r = respuestas[llamadas] ?? respuestas[respuestas.length - 1]!;
  llamadas++;
  return r;
};

const conUso = (r: RespuestaFingida) => ({
  ...r,
  usage: { input_tokens: 100, output_tokens: 2048 },
  model: 'claude-sonnet-5',
});

mock.module('@anthropic-ai/sdk', () => ({
  default: class {
    messages = {
      // La narrativa del reporte va por streaming; el chat por `create`. El doble expone
      // las dos formas porque el arreglo es el mismo en las dos.
      stream: (params: { max_tokens: number }) => {
        maxTokensPedido = params.max_tokens;
        return { finalMessage: async () => conUso(siguiente()) };
      },
      create: async (params: { messages: unknown[] }) => {
        mensajesDeLaUltimaLlamada = params.messages;
        return conUso(siguiente());
      },
    };
  },
}));

const { generateReportNarrative, generateInsightNarrative } = await import('@/lib/anthropic');
const { runChatTurn } = await import('@/lib/chat-orchestrator');

const texto = (t: string): RespuestaFingida => ({
  stop_reason: 'end_turn',
  content: [{ type: 'text', text: t }],
});
const cortada = (t: string): RespuestaFingida => ({
  stop_reason: 'max_tokens',
  content: [{ type: 'text', text: t }],
});
const usaHerramienta = (nombre: string): RespuestaFingida => ({
  stop_reason: 'tool_use',
  content: [{ type: 'tool_use', id: 'tu_1', name: nombre, input: { limit: 10 } }],
});

/** Absorbe el INSERT de `ai_usage_events` sin fingir el módulo que lo hace. */
const dbMudo = { insert: () => ({ values: async () => undefined }) } as never;

/** Y este lanza en cuanto una herramienta lo consulta: el fallo que tumbaba el turno. */
const dbQueLanza = {
  insert: () => ({ values: async () => undefined }),
  select() {
    throw new Error('relation "transactions" does not exist');
  },
} as never;

beforeEach(() => {
  llamadas = 0;
  maxTokensPedido = 0;
  mensajesDeLaUltimaLlamada = [];
  respuestas = [texto('Todo bien.')];
});

describe('narrativa de reporte (CU-868krw2wn)', () => {
  test('una respuesta completa pasa y devuelve su texto', async () => {
    respuestas = [texto('Narrativa completa.')];
    const r = await generateReportNarrative({ kpis: {} }, 'es');
    expect(r.narrative).toBe('Narrativa completa.');
  });

  test('stop_reason=max_tokens NO devuelve la narrativa cortada: lanza', async () => {
    // El caso reportado, con el detalle que lo hacía invisible: SÍ hay texto, y es texto
    // plausible. Sin mirar `stop_reason` no hay forma de distinguirlo de uno bueno.
    respuestas = [
      cortada('Los ingresos del período crecieron un 12% respecto al mes anterior, impulsados por'),
    ];

    const error = await generateReportNarrative({ kpis: {} }, 'es').catch((e) => e);
    expect(error).toBeInstanceOf(AiProviderError);
    expect((error as AiProviderError).failure).toBe('incomplete');
  });

  test('sin bloque de texto lanza, en vez del Error pelado de antes', async () => {
    // Antes: `throw new Error('Claude response had no text block')` — un 500 sin cuerpo
    // útil. Es el mismo hecho que el truncamiento y ahora sale por el mismo camino, con un
    // mensaje que se le puede enseñar a un cliente.
    respuestas = [{ stop_reason: 'end_turn', content: [] }];

    const error = await generateReportNarrative({ kpis: {} }, 'es').catch((e) => e);
    expect((error as AiProviderError).failure).toBe('incomplete');
  });

  test('un texto en blanco cuenta como narrativa ausente', async () => {
    respuestas = [texto('   \n  ')];

    const error = await generateReportNarrative({ kpis: {} }, 'es').catch((e) => e);
    expect((error as AiProviderError).failure).toBe('incomplete');
  });

  test('el presupuesto de salida es el que le pasa el llamador', async () => {
    // La otra mitad del arreglo: sin poder subir el techo, cortar en seco convertiría todo
    // reporte largo en un fallo. El llamador (lib/reports.ts) lo calcula por secciones.
    await generateReportNarrative({ kpis: {} }, 'es', undefined, 4_000);
    expect(maxTokensPedido).toBe(4_000);
  });

  test('sin presupuesto explícito usa el del tick diario, que no cambia', async () => {
    await generateReportNarrative({ kpis: {} }, 'es');
    expect(maxTokensPedido).toBe(2048);
  });
});

describe('turno del asesor (CU-868krw2gx)', () => {
  const correr = (db: never = dbMudo) =>
    runChatTurn({
      db,
      companyId: 'c1',
      locale: 'es',
      history: [],
      userMessage: '¿cómo van mis ventas?',
    });

  test('un turno normal devuelve la respuesta', async () => {
    respuestas = [texto('Tus ventas subieron 12%.')];
    const r = await correr();
    expect(r.assistantText).toBe('Tus ventas subieron 12%.');
  });

  test('SIN bloque de texto lanza en vez de devolver cadena vacía', async () => {
    // El bug exacto. Antes: `assistantText: ''`, status 200, burbuja en blanco guardada en
    // el historial — y el historial contaminado degradaba los turnos siguientes.
    respuestas = [{ stop_reason: 'end_turn', content: [] }];

    const error = await correr().catch((e) => e);
    expect(error).toBeInstanceOf(AiProviderError);
    expect((error as AiProviderError).failure).toBe('incomplete');
  });

  test('un texto en blanco cuenta como respuesta ausente', async () => {
    respuestas = [texto('   ')];

    const error = await correr().catch((e) => e);
    expect((error as AiProviderError).failure).toBe('incomplete');
  });

  test('una respuesta CORTADA por max_tokens tampoco pasa como respuesta', async () => {
    // Hay texto y es plausible, pero termina a mitad de frase. Para quien la lee, eso no es
    // una respuesta.
    respuestas = [cortada('Tus ventas su')];

    const error = await correr().catch((e) => e);
    expect((error as AiProviderError).failure).toBe('incomplete');
  });

  test('agotar las rondas de tool-use es el mismo fallo, no un 500 pelado', async () => {
    // Se usa una herramienta INEXISTENTE a propósito: el orquestador da la vuelta completa
    // sin tocar la base, así que el test mide lo que dice medir —el bucle— y no depende de
    // ninguna consulta.
    respuestas = [usaHerramienta('no-existe')];

    const error = await correr().catch((e) => e);
    expect(error).toBeInstanceOf(AiProviderError);
    expect((error as AiProviderError).failure).toBe('incomplete');
  });

  test('si una herramienta falla, el asesor RESPONDE igual', async () => {
    /*
     * La segunda causa del silencio. El `input` de una herramienta lo escribe el MODELO,
     * no un esquema validado: una fecha mal formada bastaba para que la excepción subiera
     * hasta el endpoint como 500 y se perdiera el turno entero, ni siquiera se guardaba la
     * pregunta del usuario. Ahora el fallo le llega al modelo como resultado y el modelo
     * cierra con lo que tenga.
     */
    respuestas = [
      usaHerramienta('query_transactions'),
      texto('No pude consultar el detalle, pero tus ventas subieron.'),
    ];

    const r = await correr(dbQueLanza);
    expect(r.assistantText).toContain('No pude consultar');
    expect(r.callCount).toBe(2);
  });

  test('el fallo de la herramienta viaja al modelo como resultado de herramienta', async () => {
    respuestas = [usaHerramienta('query_transactions'), texto('listo')];

    await correr(dbQueLanza);

    // El último mensaje que vio el modelo es el tool_result con el error dentro, que es lo
    // que le permite corregir o explicar en vez de que el turno muera antes.
    const ultimo = mensajesDeLaUltimaLlamada.at(-1) as { role: string; content: unknown[] };
    expect(ultimo.role).toBe('user');
    expect(JSON.stringify(ultimo.content)).toContain('ERROR');
  });
});

/**
 * ═══ LA CUARTA SUPERFICIE: EL CONSEJO DIARIO (CU-868ktm2m2) ═══
 *
 * Macha reportó "Daily Financial Advice me tira error", con 250 créditos en pantalla — o
 * sea que no era saldo. `generateInsightNarrative` quedó FUERA del arreglo de arriba: era
 * el único de los cuatro caminos que no miraba `stop_reason`, y en vez de un error de
 * dominio lanzaba un `Error` pelado que salía como 500 sin texto. El usuario veía "no
 * pudimos generar el consejo" y no quedaba rastro de por qué en ningún lado.
 *
 * Y acá el riesgo es MAYOR que en el reporte: la herramienta va forzada (`tool_choice`),
 * así que si su JSON se corta no queda bloque de texto al que degradar. Se pierden las dos
 * salidas a la vez.
 */
const insightsDe = (...textos: string[]): RespuestaFingida => ({
  stop_reason: 'tool_use',
  content: [
    {
      type: 'tool_use',
      id: 'tu_ins',
      name: 'emit_insights',
      input: { insights: textos.map((text) => ({ category: 'financial', text })) },
    },
  ],
});

describe('el consejo diario no se degrada en silencio (CU-868ktm2m2)', () => {
  test('una respuesta normal devuelve los insights y su texto', async () => {
    respuestas = [insightsDe('Cobra las facturas vencidas.', 'El margen cayó dos puntos.')];

    const r = await generateInsightNarrative({ baseCurrency: 'GTQ' }, 'prompt');

    expect(r.insights).toHaveLength(2);
    // El texto plano se RECONSTRUYE desde los insights: `insight_requests.result` lo guarda
    // desde CU-868kfvabk y ese ledger es append-only, así que su forma no se cambia.
    expect(r.narrative).toContain('Cobra las facturas vencidas.');
  });

  test('stop_reason=max_tokens lanza aunque haya insights: el JSON pudo cortarse', async () => {
    /*
     * El caso que más engaña. Con la herramienta forzada, un corte a mitad del JSON puede
     * dejar algunos insights bien formados y perder el resto — y sin mirar `stop_reason`
     * eso pasa por una respuesta completa. Un consejo al que le faltan dos de tres puntos
     * no se distingue de uno de un solo punto.
     */
    respuestas = [{ ...insightsDe('Solo el primero llegó.'), stop_reason: 'max_tokens' }];

    const error = await generateInsightNarrative({ baseCurrency: 'GTQ' }, 'prompt').catch(
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(AiProviderError);
    expect((error as AiProviderError).failure).toBe('incomplete');
  });

  test('sin insights y sin texto lanza un error de DOMINIO, no un Error pelado', async () => {
    // Antes era `throw new Error(...)`, que Elysia servía como 500 sin cuerpo. Un
    // `AiProviderError` lo traduce el handler global a un mensaje presentable y conserva
    // la causa técnica adjunta para quien investigue.
    respuestas = [{ stop_reason: 'end_turn', content: [] }];

    const error = await generateInsightNarrative({ baseCurrency: 'GTQ' }, 'prompt').catch(
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(AiProviderError);
    expect((error as AiProviderError).failure).toBe('incomplete');
    // La causa lleva los datos con los que se diagnostica sin poder reproducir.
    expect(String((error as AiProviderError).cause)).toContain('stop_reason=end_turn');
  });

  test('el error nombra la operación, para saber CUÁL de los cuatro caminos falló', async () => {
    respuestas = [{ stop_reason: 'end_turn', content: [] }];

    const error = (await generateInsightNarrative({ baseCurrency: 'GTQ' }, 'prompt').catch(
      (e: unknown) => e,
    )) as AiProviderError;

    expect(error.operation).toBe('insight_narrative');
  });
});
