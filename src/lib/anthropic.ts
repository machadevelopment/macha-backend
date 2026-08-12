import Anthropic from '@anthropic-ai/sdk';
import { env } from './env';
import { runAi } from './ai-errors';
import { buildIndustryTemplateBlock } from './industry-template';
import { assemblePayload, type ColumnMap, type RowVerdict } from './row-assembly';
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

/**
 * Precios de Claude para `cost_usd` de `ai_usage_events` — CU-868kjc9d6.
 *
 * EL PROBLEMA QUE RESUELVE. Antes había UNA constante con la tarifa introductoria de
 * `claude-sonnet-5` ($2/$10 por millón de tokens) y un comentario pidiendo revisarla a
 * mano cuando venciera. Esa tarifa vence el **2026-08-31**; a partir del 2026-09-01 la
 * de lista es $3/$15. Con una constante fija, el 1 de septiembre `cost_usd` habría
 * seguido registrando el precio viejo sin fallar nada: cada fila del ledger —que es
 * append-only, así que no se corrige— habría subestimado el costo real un 33%, y el
 * tablero de costos de IA del admin habría mentido a la baja justo en la dirección
 * peligrosa (creer que la IA sale más barata de lo que sale).
 *
 * LA FORMA DE LA SOLUCIÓN. En vez de un valor con recordatorio humano, cada modelo
 * declara sus tarifas CON VIGENCIA. `estimateCostUsd` resuelve la que aplica a la fecha
 * del evento, así que el cruce del 2026-08-31 ocurre solo, sin deploy y sin que nadie
 * se acuerde. Un tramo vencido no se borra: las tarifas viejas siguen siendo la
 * respuesta correcta para recalcular un evento pasado.
 *
 * Fuente: referencia de la skill `claude-api`, verificada el 2026-08-12. Las tarifas
 * son de la API de primera parte de Anthropic (no de Bedrock/Vertex, que facturan
 * aparte). Al cambiar de modelo hay que agregar su entrada aquí — y re-verificar ZDR,
 * ver `assertZdrModel`.
 */
type RateWindow = {
  /** Primer día (UTC, inclusive) en que rige la tarifa. */
  readonly from: string;
  /** Último día (UTC, inclusive), o null si es la vigente sin fecha de término. */
  readonly through: string | null;
  readonly input: number;
  readonly output: number;
};

const PRICES_PER_MTOK_USD: Record<string, readonly RateWindow[]> = {
  'claude-sonnet-5': [
    // Tarifa introductoria. La fecha de fin es la publicada por Anthropic, no una
    // estimación nuestra.
    { from: '2026-01-01', through: '2026-08-31', input: 2.0, output: 10.0 },
    // Tarifa de lista, ya conocida: entra sola el 2026-09-01.
    { from: '2026-09-01', through: null, input: 3.0, output: 15.0 },
  ],
};

/**
 * Tarifa más cara de todo el catálogo. Es el respaldo cuando no hay tarifa aplicable:
 * ante la duda se SOBRE-estima, nunca se sub-estima. Un costo inflado se nota al
 * revisarlo; uno deflactado se confunde con una buena noticia — y el ledger es
 * append-only, así que la fila mal calculada se queda.
 */
function tarifaMasCara(): { input: number; output: number } {
  const todas = Object.values(PRICES_PER_MTOK_USD).flat();
  return {
    input: Math.max(...todas.map((r) => r.input)),
    output: Math.max(...todas.map((r) => r.output)),
  };
}

/** Se avisa UNA vez por (modelo, fecha) para no inundar el log en un lote de ingesta. */
const avisosEmitidos = new Set<string>();

export function resolveRatePerMtok(
  model: string,
  at: Date,
): { input: number; output: number; exact: boolean } {
  const dia = at.toISOString().slice(0, 10);
  const ventanas = PRICES_PER_MTOK_USD[model];
  const vigente = ventanas?.find((r) => dia >= r.from && (r.through === null || dia <= r.through));

  if (vigente) return { input: vigente.input, output: vigente.output, exact: true };

  // No hay tarifa: modelo sin entrada en el catálogo, o fecha fuera de todo tramo (una
  // tarifa que venció sin que nadie agregara la siguiente). Los dos casos son un error
  // de mantenimiento y los dos tienen que GRITAR, que es el punto del ticket.
  const clave = `${model}@${dia}`;
  if (!avisosEmitidos.has(clave)) {
    avisosEmitidos.add(clave);
    console.warn(
      `[precios] SIN TARIFA VIGENTE para ${model} en ${dia}: cost_usd se está ` +
        `calculando con la tarifa más alta del catálogo (sobre-estima). Agregar la ` +
        `ventana correspondiente en src/lib/anthropic.ts — ver CU-868kjc9d6.`,
    );
  }
  return { ...tarifaMasCara(), exact: false };
}

export function estimateCostUsd(
  inputTokens: number,
  outputTokens: number,
  model: string = anthropicModel,
  at: Date = new Date(),
): number {
  const tarifa = resolveRatePerMtok(model, at);
  return (inputTokens / 1_000_000) * tarifa.input + (outputTokens / 1_000_000) * tarifa.output;
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
2. Devolver UNA SOLA VEZ, en "columns", el índice (base 0) de cada columna de la hoja: fecha, monto, moneda, descripción, contraparte, producto, cantidad, categoría de producto y fecha de vencimiento. Usa null cuando la hoja no traiga esa columna. Los VALORES no se devuelven: el sistema los lee de la fila usando estos índices. Devolver un índice equivocado desplaza el dato de TODA la hoja, así que mira varias filas antes de decidir.
3. Por cada fila devolver SOLO: "i" (su índice en el lote), "e" (entidad), "t" (tipo contable, solo si es transaction), "c" (categoría) y "cf" (confianza). Clasifica SIEMPRE con tu propio criterio contable: "t" está limitado a revenue/cogs/opex/other, pero "c" es texto libre — si ninguna categoría conocida aplica, inventa un nombre corto y descriptivo en snake_case (ej. "licencias_software"). Nunca descartes ni dejes sin clasificar una fila porque su encabezado no aparezca en ningún diccionario.
4. El bloque adjunto con sinónimos y ejemplos es una REFERENCIA de apoyo, no una lista cerrada: úsalo para nombrar igual lo que ya tiene nombre y para entender la jerga local, no como límite de lo que puedes clasificar.
5. Asignar "cf" (0 a 1) por fila: baja si el mapeo es ambiguo, la fecha/monto es dudoso, o la fila no encaja claramente en el esquema. Una fila que clasificaste con criterio propio, sin respaldo del diccionario, no es por eso de baja confianza — bájala solo si el dato en sí es dudoso.
6. Ignora filas que no son datos (títulos de sección, totales, subtotales, encabezados repetidos, filas vacías): no las devuelvas.
7. "sheetUsable" es tu válvula de escape y debe ser TRUE casi siempre. Ponlo en false SOLO si esta hoja no contiene movimientos financieros identificables de ninguna forma: es texto libre o notas, es una hoja de gráficas o imágenes, está vacía, o su estructura es tan inconsistente que no se pueden delimitar filas ni distinguir montos de fechas. Que los encabezados sean raros, estén en otro idioma, mezclen mayúsculas, traigan categorías que no reconoces o vengan desordenados NO es razón para false: eso se resuelve clasificando con tu criterio. Si puedes extraer aunque sea algunas filas, "sheetUsable" es true.
8. Cuando "sheetUsable" sea false, explica en "unusableReason" qué tiene el archivo, en una frase dirigida al dueño de una PYME: sin jerga técnica y describiendo lo que viste, no lo que falta.
9. La columna "product" del mapa se señala solo cuando la fila identifique un producto o servicio concreto (una columna de producto, SKU o descripción de artículo). Si la fila es un gasto general, un total o no menciona un producto identificable, devolver null — inventarlo produce un catálogo de productos falso. Ojo: esto NO contradice el punto 2. La categoría se inventa cuando hace falta porque es una etiqueta de clasificación y toda fila pertenece a alguna; el producto no se inventa nunca porque es una entidad del negocio del cliente, y una inventada aparece después como una fila más en su catálogo.
10. La columna "quantity" del mapa se señala solo si la hoja trae unidades explícitas. "quantity" son las unidades que mueve la fila, y solo cuando la fila LAS TRAE explícitamente (una columna de cantidad, unidades, libras, cajas). Devolver null si no hay tal columna: null significa "esta fila no habla de unidades" y es distinto de 0. NUNCA deducir la cantidad dividiendo el monto entre un precio unitario que aparezca en otra columna — ese cálculo parece obvio y es la forma más rápida de llenar el sistema de unidades inventadas cuando el precio de esa fila traía un descuento, un impuesto o un flete. Si la fila no dice cuántas, no sabemos cuántas.
11. "productCategory" es la familia comercial a la que pertenece el producto de ESTA fila ("bebidas", "abarrotes", "servicios"), cuando el archivo la trae en una columna o cuando el nombre del producto la hace evidente. Es una etiqueta de agrupación de productos y no tiene nada que ver con "c" del punto 3, que clasifica el movimiento contable. Devolver null si la fila no trae producto o si agruparlo sería adivinar.`;

/**
 * ESQUEMA COMPACTO — el cambio que baja el costo y el tiempo a la vez (2026-08-12).
 *
 * El esquema anterior pedía la fila RECONSTRUIDA: nueve campos por fila con sus valores, y
 * structured outputs obligaba a que vinieran los nueve incluso en null. Medido: ~71 tokens
 * de salida por fila, y el 95,7 % del costo del recibo era salida. Como el modelo genera
 * token por token, esos mismos tokens eran también los 40-50 minutos de espera.
 *
 * Siete de esos nueve campos ya los tenía el backend: se los mandó él en la fila cruda.
 *
 * Ahora el modelo devuelve UNA VEZ el mapa de columnas y POR FILA solo lo que exige criterio:
 * a qué entidad va, el tipo contable, la categoría y su confianza. Los valores los arma el
 * código con `lib/row-assembly.ts`, y el payload que sale es idéntico al de antes — nada
 * aguas abajo se entera.
 *
 * Los nombres de campo son cortos a propósito (`i`, `e`, `t`, `c`, `cf`): en un arreglo de
 * cientos de filas, el nombre de la clave se repite en cada una y es tokens de salida como
 * cualquier otro.
 */
export const CLASSIFY_ROWS_SCHEMA = {
  type: 'object',
  properties: {
    /**
     * El mapa de columnas de ESTA hoja, por índice base 0 sobre la fila cruda. `null` cuando
     * la hoja no trae esa columna — que es información legítima, no un fallo.
     */
    columns: {
      type: 'object',
      properties: {
        date: { type: ['integer', 'null'] },
        amount: { type: ['integer', 'null'] },
        currency: { type: ['integer', 'null'] },
        description: { type: ['integer', 'null'] },
        counterparty: { type: ['integer', 'null'] },
        product: { type: ['integer', 'null'] },
        quantity: { type: ['integer', 'null'] },
        productCategory: { type: ['integer', 'null'] },
        dueDate: { type: ['integer', 'null'] },
      },
      required: [
        'date',
        'amount',
        'currency',
        'description',
        'counterparty',
        'product',
        'quantity',
        'productCategory',
        'dueDate',
      ],
      additionalProperties: false,
    },
    rows: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          i: { type: 'integer', description: 'Índice base 0 de la fila dentro del lote.' },
          e: { type: 'string', enum: ['transaction', 'invoice', 'bill'] },
          /*
           * `anyOf` y no `{type:['string','null'], enum:[...,null]}`. La segunda forma es
           * JSON Schema válido y la API la RECHAZA con 400 antes de generar nada:
           * "Enum value 'revenue' does not match declared type '['string','null']'".
           * Lo atrapó la primera llamada real contra el archivo del cliente; costó cero
           * tokens, pero en producción habría sido el 100 % de los documentos fallando.
           */
          t: {
            anyOf: [
              { type: 'string', enum: ['revenue', 'cogs', 'opex', 'other'] },
              { type: 'null' },
            ],
            description: 'Solo para transaction; null en invoice/bill.',
          },
          c: { type: ['string', 'null'], description: 'Categoría, texto libre en snake_case.' },
          cf: { type: 'number', description: 'Confianza 0 a 1.' },
        },
        required: ['i', 'e', 't', 'c', 'cf'],
        additionalProperties: false,
      },
    },
    /**
     * La válvula de escape. Sin ella, un archivo que no es un libro contable —notas
     * sueltas, una hoja de gráficas, un formato tan inconsistente que no se pueden
     * delimitar filas— no tenía forma de reportarse: el modelo devolvía `rows: []` y
     * el documento terminaba en `review` con cero filas que revisar.
     */
    sheetUsable: { type: 'boolean' },
    unusableReason: {
      type: ['string', 'null'],
      description: 'Solo si sheetUsable es false: qué tiene el archivo, en una frase.',
    },
  },
  required: ['columns', 'rows', 'sheetUsable', 'unusableReason'],
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
  /** Moneda de la empresa: se usa cuando la hoja no trae columna de moneda. */
  baseCurrency: string;
  /**
   * Fila de encabezados de la hoja, si la tiene. Va SIEMPRE en el prompt aunque el lote no
   * la contenga: los lotes 2 en adelante no la traen, y sin ella el modelo tendría que
   * adivinar el mapa de columnas a partir de puros valores en cada lote — el mismo mapa
   * saldría distinto en el lote 1 y en el 5, y los datos del cliente quedarían desplazados
   * en la mitad de la hoja. No se agrega a `rows` para no correr los índices.
   */
  headerRow?: unknown[];
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
            text:
              `Hoja: "${params.sheetName}"\n` +
              (params.headerRow
                ? `Encabezados de la hoja (los índices de "columns" son sobre este array): ${JSON.stringify(params.headerRow)}\n`
                : '') +
              `Filas crudas (una por línea, array JSON de celdas; "i" es su posición en esta lista, empezando en 0):\n${rowsText}`,
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

  let parsed: {
    columns: ColumnMap;
    rows: {
      i: number;
      e: ClassifiedRow['targetEntity'];
      t: RowVerdict['type'];
      c: string | null;
      cf: number;
    }[];
    sheetUsable: boolean;
    unusableReason: string | null;
  };
  try {
    parsed = JSON.parse(textBlock.text);
  } catch (err) {
    throw new Error('Claude response was not valid JSON despite structured output', { cause: err });
  }

  /*
   * ACÁ SE ARMA EL PAYLOAD, con la fila cruda que ya teníamos y el mapa que el modelo
   * devolvió una sola vez. Antes esto venía reconstruido en la respuesta: nueve campos por
   * fila, y el 95,7 % del costo —y del tiempo— era eso.
   *
   * Un `i` fuera de rango se DESCARTA en vez de tumbar el lote: el modelo puede devolver un
   * índice que no existe, y perder una fila de trescientas es mejor que perder las
   * trescientas. La fila descartada simplemente no llega a staging, igual que una que el
   * modelo hubiera decidido ignorar por no ser un dato.
   */
  const rows: ClassifiedRow[] = parsed.rows.flatMap((v) => {
    const row = params.rows[v.i];
    if (!row) return [];
    return [
      {
        targetEntity: v.e,
        confidence: typeof v.cf === 'number' ? v.cf : 0,
        payload: assemblePayload({
          verdict: { i: v.i, targetEntity: v.e, type: v.t, category: v.c, confidence: v.cf },
          row,
          columns: parsed.columns,
          baseCurrency: params.baseCurrency,
        }),
      },
    ];
  });

  return {
    rows,
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

/**
 * Categorías del consejo (ronda de QA 2026-08-11, prompt de rediseño §3.4).
 *
 * Son CÓDIGOS, no etiquetas: el frontend los traduce a ES/EN, igual que hace con
 * `ruleKey` de las alertas. Devolver "Cobranza" desde acá obligaría al backend a saber el
 * idioma del usuario para algo que es una clasificación, no un texto.
 *
 * Son exactamente las tres del ticket. `financial` hace de cajón general a propósito: un
 * insight de costos o de margen entra ahí. Abrir más categorías es una decisión de producto,
 * no una que se toma escribiendo el enum.
 */
export const INSIGHT_CATEGORIES = ['collections', 'sales', 'financial'] as const;
export type InsightCategory = (typeof INSIGHT_CATEGORIES)[number];

export type InsightItem = { category: InsightCategory; text: string };

/**
 * Resultado de una narrativa de IA a secas: texto y contabilidad de tokens. Lo devuelve la
 * narrativa de REPORTE, que no clasifica nada — son 3-4 párrafos ejecutivos, no una lista
 * de consejos.
 *
 * Existe separado de `InsightResult` para no obligar al reporte a devolver un `insights: []`
 * que no significa "no hubo" sino "acá no aplica". Un array vacío con dos lecturas posibles
 * es justo el tipo de ambigüedad que después se lee mal en el consumidor.
 */
export type NarrativeResult = {
  narrative: string;
  inputTokens: number;
  outputTokens: number;
  model: string;
};

export type InsightResult = NarrativeResult & {
  /**
   * Los insights ya separados y clasificados por el modelo. Es el dato bueno.
   *
   * Puede venir VACÍO si el modelo respondió en texto en vez de llamar a la herramienta
   * (ver `generateInsightNarrative`): en ese caso `narrative` sigue trayendo el texto y el
   * frontend degrada a mostrarlo sin categorías, que es lo que hacía antes.
   */
  insights: InsightItem[];
  /**
   * El texto completo. Se CONSERVA aunque ahora haya estructura, por dos razones: es lo
   * que `insight_requests.result` guarda desde CU-868kfvabk —y ese ledger es append-only,
   * así que su forma no se cambia a la ligera— y es el respaldo cuando el modelo no usa la
   * herramienta.
   */
  narrative: string;
};

/**
 * La estructura se pide por HERRAMIENTA, no metiéndola en el texto del prompt, y esa
 * decisión es el centro de este cambio.
 *
 * El prompt de insight es configurable: vive en `platform_settings.insight_prompt_template`
 * y un operador puede haberlo reescrito desde Business parameters. Si la instrucción de
 * "devolvé categorías" viviera en el TEXTO, `DEFAULT_INSIGHT_PROMPT` solo aplicaría a
 * entornos nuevos —los que ya tienen la fila conservan su prompt— y la clasificación
 * llegaría vacía en producción sin que nada fallara. Pidiéndola por el esquema de la
 * herramienta, funciona con cualquier prompt, incluido uno personalizado que no mencione
 * categorías.
 */
const EMIT_INSIGHTS_TOOL: Anthropic.Tool = {
  name: 'emit_insights',
  description:
    'Entrega los insights ya separados y clasificados. Un elemento por insight; no ' +
    'agrupes dos ideas en uno ni repitas el mismo insight en dos categorías.',
  input_schema: {
    type: 'object',
    properties: {
      insights: {
        type: 'array',
        minItems: 1,
        maxItems: 5,
        items: {
          type: 'object',
          properties: {
            category: {
              type: 'string',
              enum: [...INSIGHT_CATEGORIES],
              description:
                'collections = cobranza y cuentas por cobrar; sales = ventas e ingresos; ' +
                'financial = margen, costos y salud financiera general.',
            },
            text: { type: 'string', description: 'El insight, en una o dos frases.' },
          },
          required: ['category', 'text'],
          additionalProperties: false,
        },
      },
    },
    required: ['insights'],
    additionalProperties: false,
  },
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
    tools: [EMIT_INSIGHTS_TOOL],
    // Se FUERZA la herramienta: sin esto el modelo puede contestar en prosa y la
    // clasificación no llega. No hay round-trip de tool-use que atender — la respuesta de
    // la herramienta ES el resultado, no una consulta que haya que responder.
    tool_choice: { type: 'tool', name: EMIT_INSIGHTS_TOOL.name },
  });
  const message = await runAi('insight_narrative', () => stream.finalMessage());

  const toolBlock = message.content.find(
    (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use' && b.name === EMIT_INSIGHTS_TOOL.name,
  );
  const insights = parseInsights(toolBlock?.input);

  /*
   * El texto plano se RECONSTRUYE desde los insights. `insight_requests.result` guarda esta
   * cadena desde CU-868kfvabk y ese ledger es append-only: cambiarle la forma dejaría las
   * filas viejas y las nuevas sin comparación posible. Con `\n\n` entre insights, además,
   * el frontend que ya partía por párrafo sigue funcionando sin saber de categorías.
   */
  const textBlock = message.content.find((b): b is Anthropic.TextBlock => b.type === 'text');
  const narrative = insights.length
    ? insights.map((i) => i.text).join('\n\n')
    : (textBlock?.text ?? '');

  // Sin insights Y sin texto no hay nada que mostrar: es un fallo, no un insight vacío.
  if (!narrative) throw new Error('Claude response had neither insights nor text');

  return {
    insights,
    narrative,
    inputTokens: message.usage.input_tokens,
    outputTokens: message.usage.output_tokens,
    model: message.model,
  };
}

/**
 * Valida la salida de la herramienta antes de creerle.
 *
 * `tool_use.input` es `unknown` por contrato del SDK, y un modelo puede devolver una
 * categoría fuera del enum aunque el esquema la restrinja. Un elemento inválido se DESCARTA
 * en vez de tumbar la respuesta entera: perder un insight de tres es mejor que perder los
 * tres, y el llamador ya sabe manejar la lista vacía.
 */
function parseInsights(input: unknown): InsightItem[] {
  if (!input || typeof input !== 'object' || !('insights' in input)) return [];
  const raw = (input as { insights: unknown }).insights;
  if (!Array.isArray(raw)) return [];

  const valid = new Set<string>(INSIGHT_CATEGORIES);
  return raw.flatMap((item): InsightItem[] => {
    if (!item || typeof item !== 'object') return [];
    const { category, text } = item as { category?: unknown; text?: unknown };
    if (typeof category !== 'string' || !valid.has(category)) return [];
    if (typeof text !== 'string' || text.trim() === '') return [];
    return [{ category: category as InsightCategory, text: text.trim() }];
  });
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
): Promise<NarrativeResult> {
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
