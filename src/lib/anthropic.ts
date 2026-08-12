import Anthropic from '@anthropic-ai/sdk';
import { env } from './env';
import { runAi } from './ai-errors';
import { buildIndustryTemplateBlock } from './industry-template';
import type { industryTemplateVersions } from '@/db/schema';

/**
 * Anthropic Claude is the ONLY AI provider (signed ZDR contract). Never persist prompts
 * or customer financial data in the provider. Every call must insert one ai_usage_events
 * row (kind tagged). Re-verify ZDR eligibility on any model change. Model lives in
 * config (env.anthropicModel), never hardcoded at call sites — CLAUDE.md non-negotiable.
 */
export const anthropicModel = env.anthropicModel;

export function assertZdrModel(model: string): void {
  const zdrEligible = new Set(['claude-sonnet-5']);
  if (!zdrEligible.has(model)) throw new Error(`Model ${model} not verified for ZDR`);
}

let client: Anthropic | undefined;
export function getClient(): Anthropic {
  client ??= new Anthropic({ apiKey: env.anthropicApiKey });
  return client;
}

// Pricing snapshot for cost_usd on ai_usage_events (claude-api skill reference, cached
// 2026-06-24): claude-sonnet-5 introductory rate, valid through 2026-08-31. Re-verify
// against current pricing when the intro window lapses or the model changes.
const PRICE_PER_MTOK_USD = { input: 2.0, output: 10.0 };

export function estimateCostUsd(inputTokens: number, outputTokens: number): number {
  return (
    (inputTokens / 1_000_000) * PRICE_PER_MTOK_USD.input +
    (outputTokens / 1_000_000) * PRICE_PER_MTOK_USD.output
  );
}

export type ClassifiedRow = {
  targetEntity: 'transaction' | 'invoice' | 'bill';
  confidence: number;
  payload: Record<string, unknown>;
};

export type ClassifySheetResult = {
  rows: ClassifiedRow[];
  /**
   * `false` = esta hoja no es procesable y hay que decírselo al cliente. Distinto de
   * `rows: []` con `sheetUsable: true`, que es una hoja sin movimientos (una portada,
   * un índice) y es normal en cualquier libro.
   */
  sheetUsable: boolean;
  unusableReason: string | null;
  inputTokens: number;
  outputTokens: number;
  model: string;
};

/**
 * El diccionario adjunto es una AYUDA, no la autoridad del mapeo (decisión de Keneth,
 * 2026-08-06). El motor tiene que poder con el archivo que traiga el cliente, venga como
 * venga: la contabilidad de una PYME no está normalizada y esperar que sus encabezados
 * caigan en un diccionario curado es exactamente la suposición que dejaba cargas
 * muertas. Por eso el punto 2 obliga a clasificar SIEMPRE —inventando el nombre de
 * categoría si hace falta, que es texto libre aguas abajo (lib/staging-rules.ts solo
 * exige que no sea vacío)— y la duda se expresa en `confidence`, que es el canal que sí
 * tiene salida: una fila de confianza baja va a revisión interna, no a la basura.
 */
const SYSTEM_PROMPT = `Eres un motor de estandarización de datos financieros para Macha Finance.
Recibes filas crudas de una hoja de Excel de una PYME y debes:
1. Clasificar cada fila hacia UNA de estas entidades destino: "transaction" (ingreso/costo/gasto), "invoice" (cuenta por cobrar), "bill" (cuenta por pagar).
2. Mapear los campos al esquema común. Clasifica SIEMPRE cada fila con tu propio criterio contable: "type" está limitado a revenue/cogs/opex/other, pero "category" es texto libre — si ninguna categoría conocida aplica, inventa un nombre corto y descriptivo en snake_case (ej. "licencias_software"). Nunca descartes ni dejes sin clasificar una fila porque su encabezado no aparezca en ningún diccionario.
3. El bloque adjunto con sinónimos y ejemplos es una REFERENCIA de apoyo, no una lista cerrada: úsalo para nombrar igual lo que ya tiene nombre y para entender la jerga local, no como límite de lo que puedes clasificar.
4. Asignar "confidence" (0 a 1) por fila: baja si el mapeo es ambiguo, la fecha/monto es dudoso, o la fila no encaja claramente en el esquema. Una fila que clasificaste con criterio propio, sin respaldo del diccionario, no es por eso de baja confianza — bájala solo si el dato en sí es dudoso.
5. Ignora filas que no son datos (títulos de sección, totales, subtotales, encabezados repetidos, filas vacías): no las devuelvas.
6. "sheetUsable" es tu válvula de escape y debe ser TRUE casi siempre. Ponlo en false SOLO si esta hoja no contiene movimientos financieros identificables de ninguna forma: es texto libre o notas, es una hoja de gráficas o imágenes, está vacía, o su estructura es tan inconsistente que no se pueden delimitar filas ni distinguir montos de fechas. Que los encabezados sean raros, estén en otro idioma, mezclen mayúsculas, traigan categorías que no reconoces o vengan desordenados NO es razón para false: eso se resuelve clasificando con tu criterio. Si puedes extraer aunque sea algunas filas, "sheetUsable" es true.
7. Cuando "sheetUsable" sea false, explica en "unusableReason" qué tiene el archivo, en una frase dirigida al dueño de una PYME: sin jerga técnica y describiendo lo que viste, no lo que falta.
8. Extraer "product" solo cuando la fila identifique un producto o servicio concreto (una columna de producto, SKU o descripción de artículo). Si la fila es un gasto general, un total o no menciona un producto identificable, devolver null — inventarlo produce un catálogo de productos falso. Ojo: esto NO contradice el punto 2. La categoría se inventa cuando hace falta porque es una etiqueta de clasificación y toda fila pertenece a alguna; el producto no se inventa nunca porque es una entidad del negocio del cliente, y una inventada aparece después como una fila más en su catálogo.
9. "quantity" son las unidades que mueve la fila, y solo cuando la fila LAS TRAE explícitamente (una columna de cantidad, unidades, libras, cajas). Devolver null si no hay tal columna: null significa "esta fila no habla de unidades" y es distinto de 0. NUNCA deducir la cantidad dividiendo el monto entre un precio unitario que aparezca en otra columna — ese cálculo parece obvio y es la forma más rápida de llenar el sistema de unidades inventadas cuando el precio de esa fila traía un descuento, un impuesto o un flete. Si la fila no dice cuántas, no sabemos cuántas.
10. "productCategory" es la familia comercial a la que pertenece el producto de ESTA fila ("bebidas", "abarrotes", "servicios"), cuando el archivo la trae en una columna o cuando el nombre del producto la hace evidente. Es una etiqueta de agrupación de productos y no tiene nada que ver con "category" del punto 2, que clasifica el movimiento contable. Devolver null si la fila no trae producto o si agruparlo sería adivinar.`;

// JSON Schema for structured outputs (output_config.format) — guarantees a valid,
// parseable shape instead of asking for JSON in prose and hoping. additionalProperties
// must be false on every object per the API's structured-output constraints; the two
// payload shapes (transaction vs. invoice/bill) are expressed as anyOf.
const TRANSACTION_PAYLOAD_SCHEMA = {
  type: 'object',
  properties: {
    type: { type: 'string', enum: ['revenue', 'cogs', 'opex', 'other'] },
    category: { type: 'string' },
    date: { type: 'string', description: 'YYYY-MM-DD' },
    description: { type: ['string', 'null'] },
    originalAmount: { type: 'number' },
    originalCurrency: { type: 'string', enum: ['GTQ', 'USD'] },
    // Nombre del producto o servicio, cuando la fila lo trae. `null` explícito y no
    // campo ausente: structured outputs exige listar todas las claves en `required`, y
    // dejar que el modelo omita el campo produciría payloads de forma variable.
    product: { type: ['string', 'null'], description: 'Nombre del producto o servicio' },
    // Unidades de la fila. `number|null` y no un default 0: 0 unidades vendidas y "esta
    // fila no habla de unidades" (un alquiler, un total) son cosas distintas, y sobre la
    // segunda no se puede promediar.
    quantity: {
      type: ['number', 'null'],
      description: 'Unidades que mueve la fila, solo si la fila las trae explícitamente',
    },
    // Familia comercial del producto. Distinta de `category`, que clasifica el MOVIMIENTO
    // contable (revenue/cogs/opex): un mismo producto puede aparecer en una fila de venta
    // y en una de compra, y su familia es la misma en ambas.
    productCategory: {
      type: ['string', 'null'],
      description: 'Familia comercial del producto de esta fila (bebidas, abarrotes…)',
    },
  },
  required: [
    'type',
    'category',
    'date',
    'description',
    'originalAmount',
    'originalCurrency',
    'product',
    'quantity',
    'productCategory',
  ],
  additionalProperties: false,
} as const;

const INVOICE_LIKE_PAYLOAD_SCHEMA = {
  type: 'object',
  properties: {
    counterparty: { type: 'string' },
    issueDate: { type: 'string', description: 'YYYY-MM-DD' },
    dueDate: { type: ['string', 'null'] },
    originalAmount: { type: 'number' },
    originalCurrency: { type: 'string', enum: ['GTQ', 'USD'] },
  },
  required: ['counterparty', 'issueDate', 'dueDate', 'originalAmount', 'originalCurrency'],
  additionalProperties: false,
} as const;

const CLASSIFY_ROWS_SCHEMA = {
  type: 'object',
  properties: {
    rows: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          targetEntity: { type: 'string', enum: ['transaction', 'invoice', 'bill'] },
          confidence: { type: 'number' },
          payload: { anyOf: [TRANSACTION_PAYLOAD_SCHEMA, INVOICE_LIKE_PAYLOAD_SCHEMA] },
        },
        required: ['targetEntity', 'confidence', 'payload'],
        additionalProperties: false,
      },
    },
    /**
     * La válvula de escape. Sin ella, un archivo que no es un libro contable —notas
     * sueltas, una hoja de gráficas, un formato tan inconsistente que no se pueden
     * delimitar filas— no tenía forma de reportarse: el modelo devolvía `rows: []` y
     * el documento terminaba en `review` con cero filas que revisar. El cliente veía
     * "En revisión" para siempre y Macha una revisión interna vacía.
     *
     * Es un campo aparte y no un `rows` vacío porque hacen falta las dos cosas
     * distinguidas: "no había nada que clasificar en esta hoja" (una pestaña de
     * portada, normal en cualquier libro) vs. "esto no es procesable y hay que
     * decírselo al cliente".
     */
    sheetUsable: { type: 'boolean' },
    unusableReason: {
      type: ['string', 'null'],
      description: 'Solo si sheetUsable es false: qué tiene el archivo, en una frase.',
    },
  },
  required: ['rows', 'sheetUsable', 'unusableReason'],
  additionalProperties: false,
} as const;

/**
 * CU-868kmwdqu — el lote no cupo en el presupuesto de salida y el modelo cortó a media
 * respuesta. Es un error de DIMENSIONAMIENTO, no de formato ni del proveedor, y por eso
 * tiene tipo propio: quien lo lea en `documents.error_reason` o en Sentry tiene que
 * saber que la acción es partir la hoja en lotes más chicos (config
 * `INTAKE_OUTPUT_TOKEN_BUDGET`, ver lib/sheet-batching.ts), no revisar el prompt.
 */
export class SheetOutputTruncatedError extends Error {
  constructor(
    readonly sheetName: string,
    readonly rowsInBatch: number,
  ) {
    super(
      `La hoja "${sheetName}" excede el presupuesto de salida del modelo con ${rowsInBatch} filas por llamada: la respuesta se cortó por max_tokens. Reducir INTAKE_OUTPUT_TOKEN_BUDGET o el ancho del lote.`,
    );
    this.name = 'SheetOutputTruncatedError';
  }
}

/**
 * Función aparte —y no un `if` en línea— para poder fijarla en un test sin montar un
 * cliente de Anthropic ni simular un stream. Lo que hay que poder probar es la regla,
 * no el SDK: una respuesta cortada NO es una respuesta válida.
 */
export function assertNotTruncated(
  stopReason: string | null | undefined,
  sheetName: string,
  rowsInBatch: number,
): void {
  if (stopReason === 'max_tokens') {
    throw new SheetOutputTruncatedError(sheetName, rowsInBatch);
  }
}

/**
 * One Claude call per sheet/batch (CU-868kfva8v): classifies target_entity + maps
 * fields, using structured outputs (output_config.format) for a guaranteed-parseable
 * response instead of prompting for JSON and hoping. Streaming + a generous max_tokens
 * because a full batch (intakeConfig.batchSize rows, CU-868kfv972) could approach the
 * output cap — untested against real data, revisit once real Excel samples arrive.
 */
export async function classifySheetRows(params: {
  templateVersion: Pick<typeof industryTemplateVersions.$inferSelect, 'synonyms' | 'fewShot'>;
  sheetName: string;
  rows: unknown[][];
}): Promise<ClassifySheetResult> {
  assertZdrModel(anthropicModel);
  const anthropic = getClient();
  const rowsText = params.rows.map((row) => JSON.stringify(row)).join('\n');

  const stream = anthropic.messages.stream({
    model: anthropicModel,
    max_tokens: 64_000,
    system: SYSTEM_PROMPT,
    output_config: { format: { type: 'json_schema', schema: CLASSIFY_ROWS_SCHEMA } },
    messages: [
      {
        role: 'user',
        content: [
          buildIndustryTemplateBlock(params.templateVersion),
          {
            type: 'text',
            text: `Hoja: "${params.sheetName}"\nFilas crudas (una por línea, array JSON de celdas):\n${rowsText}`,
          },
        ],
      },
    ],
  });
  const message = await runAi('classify_sheet_rows', () => stream.finalMessage());

  // CU-868kmwdqu: ANTES de intentar parsear. Si el modelo cortó por tope de salida, el
  // texto es JSON válido hasta la mitad y nada más, y el `catch` de abajo reportaba
  // "not valid JSON despite structured output" — un mensaje que manda a investigar
  // structured output, que garantiza la FORMA de la respuesta pero no que quepa. Se
  // perdió un documento real de producción detrás de ese error engañoso.
  assertNotTruncated(message.stop_reason, params.sheetName, params.rows.length);

  const textBlock = message.content.find((b): b is Anthropic.TextBlock => b.type === 'text');
  if (!textBlock) throw new Error('Claude response had no text block');

  let parsed: { rows: ClassifiedRow[]; sheetUsable: boolean; unusableReason: string | null };
  try {
    parsed = JSON.parse(textBlock.text);
  } catch (err) {
    throw new Error('Claude response was not valid JSON despite structured output', { cause: err });
  }

  return {
    rows: parsed.rows,
    // `?? true` deliberado: ante la duda, procesable. El campo es `required` en el
    // esquema, pero si alguna vez faltara, el sesgo correcto es seguir clasificando —
    // el costo de tratar un archivo bueno como ilegible (se lo rebotamos al cliente)
    // es peor que el de intentar procesar uno malo (termina en revisión).
    sheetUsable: parsed.sheetUsable ?? true,
    unusableReason: parsed.unusableReason ?? null,
    inputTokens: message.usage.input_tokens,
    outputTokens: message.usage.output_tokens,
    model: message.model,
  };
}

export type InsightResult = {
  narrative: string;
  inputTokens: number;
  outputTokens: number;
  model: string;
};

// CU-868kfvafy: default prompt, used only as a fallback when the admin hasn't set
// platform_settings['insight_prompt_template'] yet (fresh environment). The real,
// editable catalog lives in the DB now (lib/settings.ts) — this file never reads
// the DB itself (anthropic.ts stays a pure Claude client), the caller
// (modules/insights/index.ts) fetches the setting and passes it in.
export const DEFAULT_INSIGHT_PROMPT = `Eres el asistente financiero de Macha Finance. Recibes un
snapshot de métricas (ingresos/costos/margen mensuales y antigüedad de cuentas por
cobrar/pagar) de una PYME. Da 2-3 insights accionables y concretos para el dueño de la
empresa, en un tono directo y profesional. No inventes cifras que no estén en el
snapshot. Responde en texto plano, sin markdown.`;

/** On-demand insight narrative (CU-868kfvabk) — the AI narrates, never calculates (CLAUDE.md/PRD). */
export async function generateInsightNarrative(
  metricsSnapshot: unknown,
  systemPrompt: string = DEFAULT_INSIGHT_PROMPT,
): Promise<InsightResult> {
  assertZdrModel(anthropicModel);
  const anthropic = getClient();

  const stream = anthropic.messages.stream({
    model: anthropicModel,
    max_tokens: 1024,
    system: systemPrompt,
    messages: [{ role: 'user', content: JSON.stringify(metricsSnapshot) }],
  });
  const message = await runAi('insight_narrative', () => stream.finalMessage());

  const textBlock = message.content.find((b): b is Anthropic.TextBlock => b.type === 'text');
  if (!textBlock) throw new Error('Claude response had no text block');

  return {
    narrative: textBlock.text,
    inputTokens: message.usage.input_tokens,
    outputTokens: message.usage.output_tokens,
    model: message.model,
  };
}

const REPORT_SYSTEM_PROMPT = (locale: 'es' | 'en') =>
  locale === 'es'
    ? `Eres el asistente financiero de Macha Finance. Recibes las métricas exactas
(ya calculadas por SQL) de un reporte ejecutivo periódico de una PYME. Escribe una
narrativa ejecutiva de 3-4 párrafos: qué pasó, por qué importa, y 1-2 recomendaciones.
NUNCA inventes ni recalcules cifras — usa solo las del snapshot. Responde en español,
texto plano sin markdown.`
    : `You are Macha Finance's financial assistant. You receive the exact metrics
(already computed via SQL) for a PYME's periodic executive report. Write a 3-4
paragraph executive narrative: what happened, why it matters, and 1-2 recommendations.
NEVER invent or recompute figures — use only the snapshot's. Respond in English, plain
text, no markdown.`;

/**
 * Periodic report narrative (CU-868kfvacg) — same "AI narrates, never calculates" rule as
 * insights.
 *
 * CU-B2-QA-20260811: `systemPrompt` es opcional y lo arma el llamador
 * (`lib/report-prompt.ts`) a partir de las SECCIONES pedidas. Se agrega como tercer
 * parámetro opcional en vez de reemplazar `REPORT_SYSTEM_PROMPT` para que este módulo
 * siga siendo un cliente puro de Claude —no sabe qué es una sección de reporte— y para
 * que el fallback por defecto siga siendo exactamente el prompt del tick diario, que no
 * cambia de comportamiento con este ticket.
 */
export async function generateReportNarrative(
  metricsSnapshot: unknown,
  locale: 'es' | 'en',
  systemPrompt?: string,
): Promise<InsightResult> {
  assertZdrModel(anthropicModel);
  const anthropic = getClient();

  const stream = anthropic.messages.stream({
    model: anthropicModel,
    max_tokens: 2048,
    system: systemPrompt ?? REPORT_SYSTEM_PROMPT(locale),
    messages: [{ role: 'user', content: JSON.stringify(metricsSnapshot) }],
  });
  const message = await runAi('report_narrative', () => stream.finalMessage());

  const textBlock = message.content.find((b): b is Anthropic.TextBlock => b.type === 'text');
  if (!textBlock) throw new Error('Claude response had no text block');

  return {
    narrative: textBlock.text,
    inputTokens: message.usage.input_tokens,
    outputTokens: message.usage.output_tokens,
    model: message.model,
  };
}
