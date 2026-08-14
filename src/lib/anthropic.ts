import Anthropic from '@anthropic-ai/sdk';
import { env } from './env';
import { runAi } from './ai-errors';
import { buildIndustryTemplateBlock } from './industry-template';
import { assemblePayload, costoDeLaFila, type ColumnMap, type RowVerdict } from './row-assembly';
import type { industryTemplateVersions } from '@/db/schema';

/**
 * Anthropic Claude is the ONLY AI provider (signed ZDR contract). Never persist prompts
 * or customer financial data in the provider. Every call must insert one ai_usage_events
 * row (kind tagged). Re-verify ZDR eligibility on any model change. Model lives in
 * config (env.anthropicModel), never hardcoded at call sites — CLAUDE.md non-negotiable.
 */
export const anthropicModel = env.anthropicModel;

/**
 * Modelo de la clasificación de Excel. Cae al general si no se configura, así que hoy son el
 * mismo — la separación existe para que cambiarlo sea una variable de entorno y no un deploy.
 * Pasa por el MISMO `assertZdrModel`: separarlo no relaja la regla, solo la hace granular.
 */
export const anthropicIntakeModel = env.anthropicIntakeModel;

/**
 * ═══ LA LISTA BLANCA ES CONTRACTUAL, NO TÉCNICA ═══
 *
 * Estar acá NO significa "este modelo funciona". Significa que alguien verificó que el
 * contrato ZDR firmado con Anthropic lo cubre — que sus prompts y los datos financieros del
 * cliente no se retienen. Eso no se puede comprobar desde el código, solo desde la cuenta.
 *
 * Por eso agregar un modelo acá es una decisión de negocio con un paso manual, y no un
 * `push`: `CLAUDE.md` lo pone como no-negociable ("Re-verify ZDR eligibility on any model
 * change").
 *
 * SOBRE HAIKU 4.5 (medido el 2026-08-12): clasifica IGUAL que Sonnet 5 en esta tarea —
 * 100 % de coincidencia en entidad, tipo contable y categoría sobre 88 filas reales— a la
 * mitad de la latencia y ~2,4x menos costo. Todo lo demás ya está listo: sus tarifas están
 * en el catálogo y `INTAKE_MODEL` permite usarlo solo en ingesta. Falta UNA cosa, y es
 * justamente la que no puede hacer un agente: confirmar que el contrato ZDR lo cubre.
 * Cuando eso esté confirmado, esto es una línea.
 */
export function assertZdrModel(model: string): void {
  const zdrEligible = new Set(['claude-sonnet-5']);
  if (!zdrEligible.has(model)) {
    throw new Error(
      `El modelo ${model} no está verificado para ZDR. No es un error de configuración: ` +
        `agregarlo a la lista blanca de assertZdrModel exige confirmar antes que el contrato ` +
        `ZDR con Anthropic lo cubra (CLAUDE.md, regla no-negociable).`,
    );
  }
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
  /*
   * Haiku 4.5, verificado contra la referencia de la API el 2026-08-12. Sin ventana de
   * vigencia: su tarifa es de lista, no introductoria, así que no vence.
   *
   * DOS CLAVES PARA EL MISMO MODELO, y no es redundancia: `cost_usd` se calcula con
   * `message.model` —lo que la API dice que atendió la llamada— y ese campo puede devolver
   * el alias o el id con fecha según cómo se haya pedido. Con una sola clave, la otra forma
   * caería en `tarifaMasCara()` y el panel de costos mentiría al alza sin fallar nada.
   */
  'claude-haiku-4-5': [{ from: '2025-10-01', through: null, input: 1.0, output: 5.0 }],
  'claude-haiku-4-5-20251001': [{ from: '2025-10-01', through: null, input: 1.0, output: 5.0 }],
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

/**
 * Multiplicadores del caché de prompt sobre la tarifa de ENTRADA del modelo.
 *
 * No son tarifas propias: Anthropic los define como un factor sobre el precio de entrada,
 * así que expresarlos así hace que el cruce de tarifa del 2026-09-01 los arrastre solo, sin
 * una segunda tabla que alguien tendría que acordarse de actualizar.
 *
 * Escribir en el caché cuesta MÁS que no usarlo (1,25x) y leerlo cuesta mucho menos (0,1x).
 * Por eso el caché solo conviene cuando el mismo prefijo se reusa: con una sola llamada por
 * documento sería más caro. Con ~10 lotes por documento —el número de hoy— se paga en la
 * segunda llamada.
 */
const CACHE_WRITE_MULTIPLIER = 1.25;
const CACHE_READ_MULTIPLIER = 0.1;

/**
 * Costo de una llamada.
 *
 * ═══ LOS TOKENS DE CACHÉ SE COBRAN Y NO SE ESTABAN CONTANDO ═══
 *
 * `usage.input_tokens` de la API EXCLUYE lo servido desde caché y lo escrito al crearla —
 * van en `cache_read_input_tokens` y `cache_creation_input_tokens`. Como esta función solo
 * recibía `inputTokens`, todo lo que entraba por caché se costeaba como CERO desde que
 * existe el bloque cacheable (CU-868kfva91).
 *
 * El error iba hacia el lado peligroso, el mismo que motivó las tarifas con vigencia de
 * CU-868kjc9d6: hacia creer que la IA sale más barata de lo que sale. Es chico en valor
 * absoluto —la lectura de caché vale una décima parte— pero un ledger de costos que
 * subestima no sirve para decidir nada.
 *
 * Los dos parámetros son opcionales y default 0 para que las llamadas sin caché no cambien
 * de resultado, y para que el histórico se pueda recalcular tal como se registró.
 */
export function estimateCostUsd(
  inputTokens: number,
  outputTokens: number,
  model: string = anthropicModel,
  at: Date = new Date(),
  cacheReadTokens = 0,
  cacheCreationTokens = 0,
): number {
  const tarifa = resolveRatePerMtok(model, at);
  const porMillon = (tokens: number, precio: number) => (tokens / 1_000_000) * precio;

  return (
    porMillon(inputTokens, tarifa.input) +
    porMillon(outputTokens, tarifa.output) +
    porMillon(cacheCreationTokens, tarifa.input * CACHE_WRITE_MULTIPLIER) +
    porMillon(cacheReadTokens, tarifa.input * CACHE_READ_MULTIPLIER)
  );
}

export type ClassifiedRow = {
  targetEntity: 'transaction' | 'invoice' | 'bill';
  confidence: number;
  payload: Record<string, unknown>;
};

/** Lo que el modelo dice de UNA fila. `skip` = "no es un dato", dicho explícitamente. */
type VeredictoCrudo = {
  i: number;
  e: ClassifiedRow['targetEntity'] | 'skip';
  t: RowVerdict['type'];
  c: string | null;
  cf: number;
};

/**
 * Arma las filas clasificadas a partir de los veredictos ya validados por índice.
 *
 * Los `skip` se caen acá y en ningún otro lado: son filas que el modelo declaró que no son
 * datos, y esa declaración es justamente lo que las distingue de una fila perdida. No
 * generan fila de staging, pero SÍ cuentan como cubiertas.
 */
export function construirFilas(
  porIndice: Map<number, VeredictoCrudo>,
  params: { rows: unknown[][]; baseCurrency: string },
  columns: ColumnMap,
): ClassifiedRow[] {
  const out: ClassifiedRow[] = [];
  for (const [i, v] of porIndice) {
    if (v.e === 'skip') continue;
    const row = params.rows[i]!;
    const verdict = { i, targetEntity: v.e, type: v.t, category: v.c, confidence: v.cf };

    out.push({
      targetEntity: v.e,
      confidence: typeof v.cf === 'number' ? v.cf : 0,
      payload: assemblePayload({ verdict, row, columns, baseCurrency: params.baseCurrency }),
    });

    /*
     * ═══ UNA FILA DE VENTA CON COSTO PRODUCE DOS TRANSACCIONES ═══
     *
     * Los libros de PYME traen el ingreso y el costo en la MISMA línea. Como cada fila
     * producía UNA transacción, el costo se perdía entero: `cogs = 0` para todos los
     * productos y margen 100 % en la pantalla de Ventas por producto — con el dato ahí, en
     * la celda de al lado. Observado en producción el 2026-08-14.
     *
     * Solo se desdobla una fila de INGRESO: el costo acompaña a una venta. Si el modelo ya
     * clasificó la fila como `cogs`, su monto YA es el costo y agregarle otro lo duplicaría.
     * Y solo para `transaction` — una factura o una cuenta por pagar no llevan costo de
     * ventas propio.
     *
     * La fila de costo hereda fecha, producto y categoría de la venta: es el mismo hecho
     * económico visto por su otra cara, y sin la fecha no entraría al mismo período ni sin
     * el producto al mismo margen.
     */
    if (v.e !== 'transaction' || v.t !== 'revenue') continue;
    const costo = costoDeLaFila(row, columns);
    if (costo === null || costo === 0) continue;

    const venta = assemblePayload({ verdict, row, columns, baseCurrency: params.baseCurrency });
    out.push({
      targetEntity: 'transaction',
      confidence: typeof v.cf === 'number' ? v.cf : 0,
      payload: {
        ...venta,
        type: 'cogs',
        category: 'costo_de_ventas',
        originalAmount: costo,
        // Las unidades ya las contó la fila de ingreso. Repetirlas acá las duplicaría en
        // cualquier conteo de "unidades vendidas".
        quantity: null,
      },
    });
  }
  return out;
}

export type ClassifySheetResult = {
  rows: ClassifiedRow[];
  /**
   * El mapa de columnas que este lote usó para armar los valores.
   *
   * Se expone para que el llamador pueda COMPARARLO entre los lotes de una misma hoja. Cada
   * lote lo pide por su cuenta, así que nada garantiza que coincidan — y si el lote 3 dice
   * que el monto es la columna 13 y el lote 7 dice que es la 8, media hoja entra con el monto
   * equivocado, plausible y sin un solo error. Ver `assertMismoMapa`.
   */
  columns: ColumnMap;
  /**
   * Índices (sobre las filas enviadas) que el modelo NO cubrió ni en el primer intento ni en
   * el reintento. El worker los manda a staging con confianza 0 para que caigan en revisión:
   * que un humano los vea es lento, perderlos es peor.
   */
  unclassifiedRows: number[];
  /**
   * `false` = esta hoja no es procesable y hay que decírselo al cliente. Distinto de
   * `rows: []` con `sheetUsable: true`, que es una hoja sin movimientos (una portada,
   * un índice) y es normal en cualquier libro.
   */
  sheetUsable: boolean;
  unusableReason: string | null;
  inputTokens: number;
  outputTokens: number;
  /** Ver `estimateCostUsd`: NO están incluidos en `inputTokens`. */
  cacheReadTokens: number;
  cacheCreationTokens: number;
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
export const SYSTEM_PROMPT = `Eres un motor de estandarización de datos financieros para Macha Finance.
Recibes filas crudas de una hoja de Excel de una PYME y debes:
1. Clasificar cada fila hacia UNA de estas entidades destino: "transaction" (ingreso/costo/gasto), "invoice" (cuenta por cobrar), "bill" (cuenta por pagar).
2. Devolver UNA SOLA VEZ, en "columns", el índice (base 0) de cada columna de la hoja: fecha, monto, moneda, descripción, contraparte, producto, cantidad, categoría de producto, fecha de vencimiento y COSTO de la fila (ver punto 11 — si la hoja trae el costo junto al ingreso, señalarlo es obligatorio: sin él el sistema calcula 100% de margen en todo). Usa null cuando la hoja no traiga esa columna. Los VALORES no se devuelven: el sistema los lee de la fila usando estos índices. Devolver un índice equivocado desplaza el dato de TODA la hoja, así que mira varias filas antes de decidir.
3. Devolver EXACTAMENTE UNA entrada por cada fila del lote, sin excepción: si el lote trae 88 filas, "rows" trae 88 entradas con los índices 0 a 87, cada uno una sola vez. Ninguna fila se omite y ningún índice se inventa. Por cada fila devolver SOLO: "i" (su índice en el lote), "e" (entidad), "t" (tipo contable, solo si es transaction), "c" (categoría) y "cf" (confianza). Clasifica SIEMPRE con tu propio criterio contable: "t" está limitado a revenue/cogs/opex/other, pero "c" es texto libre — si ninguna categoría conocida aplica, inventa un nombre corto y descriptivo en snake_case (ej. "licencias_software"). Nunca descartes ni dejes sin clasificar una fila porque su encabezado no aparezca en ningún diccionario.
4. El bloque adjunto con sinónimos y ejemplos es una REFERENCIA de apoyo, no una lista cerrada: úsalo para nombrar igual lo que ya tiene nombre y para entender la jerga local, no como límite de lo que puedes clasificar.
5. Asignar "cf" (0 a 1) por fila: baja si el mapeo es ambiguo, la fecha/monto es dudoso, o la fila no encaja claramente en el esquema. Una fila que clasificaste con criterio propio, sin respaldo del diccionario, no es por eso de baja confianza — bájala solo si el dato en sí es dudoso.
6. Las filas que no son datos (títulos de sección, totales, subtotales, encabezados repetidos, filas vacías) SÍ se devuelven, con "e" = "skip" y el resto en null. No las omitas: omitir una fila es indistinguible de un error, y el sistema no puede saber si la ignoraste a propósito.
7. "sheetUsable" es tu válvula de escape y debe ser TRUE casi siempre. Ponlo en false SOLO si esta hoja no contiene movimientos financieros identificables de ninguna forma: es texto libre o notas, es una hoja de gráficas o imágenes, está vacía, o su estructura es tan inconsistente que no se pueden delimitar filas ni distinguir montos de fechas. Que los encabezados sean raros, estén en otro idioma, mezclen mayúsculas, traigan categorías que no reconoces o vengan desordenados NO es razón para false: eso se resuelve clasificando con tu criterio. Si puedes extraer aunque sea algunas filas, "sheetUsable" es true.
8. Cuando "sheetUsable" sea false, explica en "unusableReason" qué tiene el archivo, en una frase dirigida al dueño de una PYME: sin jerga técnica y describiendo lo que viste, no lo que falta.
9. La columna "product" del mapa se señala solo cuando la fila identifique un producto o servicio concreto (una columna de producto, SKU o descripción de artículo). Si la fila es un gasto general, un total o no menciona un producto identificable, devolver null — inventarlo produce un catálogo de productos falso. Ojo: esto NO contradice el punto 2. La categoría se inventa cuando hace falta porque es una etiqueta de clasificación y toda fila pertenece a alguna; el producto no se inventa nunca porque es una entidad del negocio del cliente, y una inventada aparece después como una fila más en su catálogo.
10. La columna "quantity" del mapa se señala solo si la hoja trae unidades explícitas. "quantity" son las unidades que mueve la fila, y solo cuando la fila LAS TRAE explícitamente (una columna de cantidad, unidades, libras, cajas). Devolver null si no hay tal columna: null significa "esta fila no habla de unidades" y es distinto de 0. NUNCA deducir la cantidad dividiendo el monto entre un precio unitario que aparezca en otra columna — ese cálculo parece obvio y es la forma más rápida de llenar el sistema de unidades inventadas cuando el precio de esa fila traía un descuento, un impuesto o un flete. Si la fila no dice cuántas, no sabemos cuántas.
11. "costTotal" y "costUnit" son las columnas de COSTO de la propia fila, y solo una de las dos (o ninguna). Muchos libros de PYME traen el ingreso y el costo en la misma línea ("Ingreso Total" junto a "Costo Total", o "PrecioUnitario" junto a "CostoUnitario"). Señala "costTotal" cuando la columna ya es el costo de la línea completa, y "costUnit" cuando es el costo de UNA unidad. NUNCA señales como costo una columna de precio de venta, de utilidad, de margen ni de descuento: el costo es lo que le costó al negocio, no lo que cobró ni lo que ganó. Si la hoja no trae costo, las dos van en null — inventarlo produciría un margen falso.
12. "productCategory" es la familia comercial a la que pertenece el producto de ESTA fila ("bebidas", "abarrotes", "servicios"), cuando el archivo la trae en una columna o cuando el nombre del producto la hace evidente. Es una etiqueta de agrupación de productos y no tiene nada que ver con "c" del punto 3, que clasifica el movimiento contable. Devolver null si la fila no trae producto o si agruparlo sería adivinar.`;

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
        /*
         * El COSTO de la propia fila de venta. Sin esto, una hoja que trae "Ingreso Total"
         * y "Costo Total" en la misma línea perdía el costo entero: `cogs = 0` para todos
         * los productos y 100 % de margen en toda la pantalla. Observado en producción el
         * 2026-08-14 con el archivo de una cafetería.
         *
         * Dos índices porque las hojas reales traen las dos formas y confundirlas multiplica
         * o divide el costo por las unidades.
         */
        costTotal: {
          type: ['integer', 'null'],
          description: 'Columna con el COSTO TOTAL de la línea. No el precio de venta.',
        },
        costUnit: {
          type: ['integer', 'null'],
          description: 'Columna con el costo de UNA unidad, si la hoja lo da así.',
        },
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
        'costTotal',
        'costUnit',
      ],
      additionalProperties: false,
    },
    rows: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          i: { type: 'integer', description: 'Índice base 0 de la fila dentro del lote.' },
          /*
           * `skip` NO es una entidad destino: es "esta fila no es un dato" dicho en voz alta
           * (un título de sección, un total, un encabezado repetido).
           *
           * Antes el modelo expresaba eso OMITIENDO la fila, y ahí estaba el problema: una
           * fila omitida a propósito y una fila que el modelo simplemente no devolvió se ven
           * exactamente igual desde el código. Medido el 2026-08-12: una corrida devolvió
           * 772 de 800 filas y la siguiente, sobre el mismo archivo, las 800 — o sea que la
           * pérdida existe, es intermitente y era invisible.
           *
           * Con `skip` obligatorio, el silencio deja de ser ambiguo: toda fila tiene que
           * volver con un veredicto, y una que no vuelve es una ANOMALÍA detectable, no una
           * decisión. Cuesta ~10 tokens por fila ignorada, que son pocas por hoja.
           */
          e: { type: 'string', enum: ['transaction', 'invoice', 'bill', 'skip'] },
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
 * Indexa los veredictos por fila y separa los que apuntan a filas que no existen.
 *
 * `porIndice` se queda con el PRIMERO de cada índice repetido: quedarse con el primero es
 * estable entre corridas, y elegir "el último" no tendría mejor argumento.
 */
export function indexarVeredictos(
  veredictos: VeredictoCrudo[],
  totalFilas: number,
): { porIndice: Map<number, VeredictoCrudo>; fueraDeRango: number } {
  const porIndice = new Map<number, VeredictoCrudo>();
  let fueraDeRango = 0;
  for (const v of veredictos) {
    if (!Number.isInteger(v.i) || v.i < 0 || v.i >= totalFilas) {
      fueraDeRango++;
      continue;
    }
    if (!porIndice.has(v.i)) porIndice.set(v.i, v);
  }
  return { porIndice, fueraDeRango };
}

/**
 * ═══ EL FALLO MÁS CARO POSIBLE, Y POR ESO TIENE SU PROPIA FUNCIÓN ═══
 *
 * Si el modelo numerara las filas desde 1 en vez de desde 0, devolvería los índices 1..N para
 * un lote de N filas. Sin este chequeo el sistema haría dos cosas, las dos en silencio:
 * descartar el índice N por fuera de rango (una fila perdida) y aplicar el veredicto de CADA
 * fila a la fila ANTERIOR. La contabilidad entera del lote quedaría corrida una posición, con
 * montos y fechas perfectamente plausibles y sin un solo error en ningún log.
 *
 * La firma es inconfundible y por eso se puede detectar sin falsos positivos: falta el 0,
 * está el N, y todo lo del medio está cubierto. Un modelo que simplemente se saltó la primera
 * fila NO dispara esto, porque no habría devuelto también el índice N.
 */
export function hayDesplazamiento(veredictos: VeredictoCrudo[], totalFilas: number): boolean {
  if (totalFilas < 2) return false;
  const idx = new Set(veredictos.map((v) => v.i));
  if (idx.has(0) || !idx.has(totalFilas)) return false;
  for (let i = 1; i <= totalFilas; i++) if (!idx.has(i)) return false;
  return true;
}

/**
 * El lote llegó con los índices corridos una posición. Tipo propio, no un `Error` genérico:
 * quien lo lea en Sentry tiene que entender que NO es un problema de formato ni del
 * proveedor, y que abortar fue lo correcto — reintentar es seguro, promover no lo sería.
 */
export class SheetIndexShiftError extends Error {
  constructor(
    readonly sheetName: string,
    readonly rowsInBatch: number,
  ) {
    super(
      `El modelo numeró las filas desde 1 en la hoja "${sheetName}" (${rowsInBatch} filas): ` +
        `los veredictos están corridos una posición y aplicarlos desplazaría todos los datos ` +
        `del lote. Abortado a propósito.`,
    );
    this.name = 'SheetIndexShiftError';
  }
}

/**
 * ═══ EL MAPA DE COLUMNAS TIENE QUE SER EL MISMO EN TODA LA HOJA ═══
 *
 * Cada lote le pide el mapa al modelo por su cuenta, y hasta acá nada obligaba a que las
 * respuestas coincidieran. Si el lote 3 decide que el monto es la columna 13 y el lote 7 que
 * es la 8, la primera mitad de la hoja entra con `TotalLinea` y la segunda con
 * `PrecioUnitario`: montos plausibles, ningún error, y la contabilidad del cliente mal a la
 * mitad.
 *
 * Es el último modo de corrupción silenciosa que quedaba en la ingesta. Medido el 2026-08-12
 * sobre tres lotes bien separados de la misma hoja real, los tres mapas coincidieron — o sea
 * que hoy no está pasando. Pero "no está pasando" no es una garantía, y el costo de
 * comprobarlo es una comparación de nueve enteros.
 *
 * Se compara contra el PRIMER mapa de la hoja y no por mayoría: la mayoría exigiría esperar a
 * que terminen todos los lotes, y para entonces las filas ya estarían insertadas. Esto corre
 * ANTES de la transacción del lote, así que un mapa discrepante no llega a escribir nada.
 */
export function fusionarMapaDeColumnas(
  sheetName: string,
  canonico: ColumnMap,
  delLote: ColumnMap,
): ColumnMap {
  const conflictos: string[] = [];
  const fusionado = {} as ColumnMap;

  for (const k of Object.keys(canonico) as (keyof ColumnMap)[]) {
    const a = canonico[k];
    const b = delLote[k];

    /*
     * ═══ "UN VALOR CONTRA NULL" NO ES UNA CONTRADICCIÓN ═══
     *
     * Es el error que cometí al escribir este guardia, y salió a producción: comparaba con
     * `!==`, así que `amount: 7 vs null` contaba como conflicto y tumbaba el documento.
     *
     * Un lote devuelve null en una columna cuando SU tramo de filas no permite verla — un
     * bloque de totales, filas vacías, una sección con celdas en blanco. No está afirmando
     * "esa columna no existe en la hoja"; está diciendo "acá no la distingo". Que otro lote
     * sí la haya visto no lo contradice: la completa.
     *
     * Observado en archivos reales de clientes el 2026-08-14 (hojas "Racum 2025" y
     * "Ventas_Diarias"): documentos abortados y atascados en `processing` por esto.
     *
     * Se toma el valor que exista. Si los dos existen y coinciden, no hay nada que decidir.
     */
    if (a === null) {
      fusionado[k] = b;
      continue;
    }
    if (b === null || a === b) {
      fusionado[k] = a;
      continue;
    }

    /*
     * LA CORRUPCIÓN DE VERDAD, y la única: dos lotes afirman que la MISMA columna está en
     * posiciones distintas. Uno lee `TotalLinea` y el otro `PrecioUnitario` — las dos son
     * columnas de dinero creíbles, así que media hoja entraría con el precio de una unidad
     * en vez del total de la línea y ningún validador lo notaría.
     *
     * Acá sí se aborta, y antes de la transacción del lote: no se escribe una sola fila.
     */
    conflictos.push(`${k}: ${a} vs ${b}`);
    fusionado[k] = a;
  }

  if (conflictos.length > 0) throw new SheetColumnMapMismatchError(sheetName, conflictos);
  return fusionado;
}

/**
 * Dos lotes de la misma hoja leyeron columnas distintas. Tipo propio porque la acción no es
 * obvia: NO es reintentar el prompt ni revisar el proveedor. Es que la hoja es ambigua para
 * el modelo —columnas parecidas, encabezados repetidos— y hay que mirarla.
 */
export class SheetColumnMapMismatchError extends Error {
  constructor(
    readonly sheetName: string,
    readonly diferencias: string[],
  ) {
    super(
      `Dos lotes de la hoja "${sheetName}" leyeron columnas distintas (${diferencias.join('; ')}). ` +
        `Aplicarlos dejaría media hoja con los valores de otra columna, sin error visible. ` +
        `Lote abortado antes de escribir nada.`,
    );
    this.name = 'SheetColumnMapMismatchError';
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
   * Mapa que ya fijaron los lotes ANTERIORES de esta hoja. Se fusiona con el que devuelve
   * este lote y el resultado es lo que arma los valores: una columna que este lote no pudo
   * distinguir se lee igual, porque es la misma hoja.
   */
  columnsCanonicas?: ColumnMap;
  /**
   * Marca la segunda pasada sobre las filas que el modelo no cubrió. Corta la recursión en
   * uno: si el reintento tampoco las cubre, el problema no es suerte y seguir intentando solo
   * quema dinero — se marcan para revisión y sigue.
   */
  esReintento?: boolean;
  /**
   * Fila de encabezados de la hoja, si la tiene. Va SIEMPRE en el prompt aunque el lote no
   * la contenga: los lotes 2 en adelante no la traen, y sin ella el modelo tendría que
   * adivinar el mapa de columnas a partir de puros valores en cada lote — el mismo mapa
   * saldría distinto en el lote 1 y en el 5, y los datos del cliente quedarían desplazados
   * en la mitad de la hoja. No se agrega a `rows` para no correr los índices.
   */
  headerRow?: unknown[];
}): Promise<ClassifySheetResult> {
  assertZdrModel(anthropicIntakeModel);
  const anthropic = getClient();
  const rowsText = params.rows.map((row) => JSON.stringify(row)).join('\n');

  const stream = anthropic.messages.stream({
    model: anthropicIntakeModel,
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
    rows: VeredictoCrudo[];
    sheetUsable: boolean;
    unusableReason: string | null;
  };
  try {
    parsed = JSON.parse(textBlock.text);
  } catch (err) {
    throw new Error('Claude response was not valid JSON despite structured output', { cause: err });
  }

  /*
   * ═══ COBERTURA: NINGUNA FILA DESAPARECE EN SILENCIO ═══
   *
   * Antes acá se armaba lo que llegara y punto. Si el modelo devolvía 60 veredictos para un
   * lote de 88 filas, las otras 28 simplemente no existían — no fallaba nada, no se
   * registraba nada, y esas filas nunca aparecían en la contabilidad del cliente.
   *
   * Que eso pasa está medido (2026-08-12): una corrida sobre el archivo real devolvió 772 de
   * 800 filas; la siguiente, sobre el MISMO archivo, devolvió las 800. Intermitente, o sea
   * irreproducible, o sea imposible de encontrar por reporte de usuario.
   *
   * Ahora se compara lo devuelto contra lo enviado. Es una resta que el código siempre pudo
   * hacer y no hacía.
   */
  /*
   * El mapa con el que se arman los valores es el de la HOJA, no el de este lote: si un lote
   * anterior distinguió la columna de monto y este no, se usa la del anterior. Lanza solo
   * ante un conflicto real (la misma columna en dos posiciones).
   */
  const columnas = params.columnsCanonicas
    ? fusionarMapaDeColumnas(params.sheetName, params.columnsCanonicas, parsed.columns)
    : parsed.columns;

  const { porIndice, fueraDeRango } = indexarVeredictos(parsed.rows, params.rows.length);

  if (hayDesplazamiento(parsed.rows, params.rows.length)) {
    throw new SheetIndexShiftError(params.sheetName, params.rows.length);
  }

  const faltantes: number[] = [];
  for (let i = 0; i < params.rows.length; i++) if (!porIndice.has(i)) faltantes.push(i);

  /*
   * UN reintento, solo con las filas que faltaron. Es barato —son pocas— y resuelve el caso
   * intermitente sin mandar a un humano a revisar algo que el modelo sí sabe clasificar.
   *
   * Uno solo y no un bucle: si el segundo intento tampoco las cubre, el problema no es
   * suerte y reintentar más solo quema dinero. Lo que sigue es marcarlas para revisión, que
   * es lento pero no pierde nada.
   */
  if (faltantes.length > 0 && !params.esReintento) {
    console.warn(
      `[ingesta] "${params.sheetName}": el modelo no cubrió ${faltantes.length} de ` +
        `${params.rows.length} filas. Reintentando solo esas.`,
    );

    const reintento = await classifySheetRows({
      ...params,
      rows: faltantes.map((i) => params.rows[i]!),
      esReintento: true,
    });

    return {
      // Lo que sí vino del primer intento, más lo que rescató el reintento. Los payloads del
      // reintento ya se armaron contra las MISMAS filas crudas, así que se concatenan tal cual.
      rows: [...construirFilas(porIndice, params, columnas), ...reintento.rows],
      columns: columnas,
      // `unclassifiedRows` del reintento indexa SU lote; se remapea a los índices originales.
      unclassifiedRows: reintento.unclassifiedRows.map((k) => faltantes[k]!),
      sheetUsable: parsed.sheetUsable ?? true,
      unusableReason: parsed.unusableReason ?? null,
      inputTokens: message.usage.input_tokens + reintento.inputTokens,
      outputTokens: message.usage.output_tokens + reintento.outputTokens,
      cacheReadTokens: (message.usage.cache_read_input_tokens ?? 0) + reintento.cacheReadTokens,
      cacheCreationTokens:
        (message.usage.cache_creation_input_tokens ?? 0) + reintento.cacheCreationTokens,
      model: message.model,
    };
  }

  if (fueraDeRango > 0) {
    console.warn(
      `[ingesta] "${params.sheetName}": ${fueraDeRango} índice(s) fuera de rango descartado(s).`,
    );
  }

  const rows = construirFilas(porIndice, params, columnas);

  /*
   * ═══ LA FILA QUE NI ASÍ SE CLASIFICÓ NO SE TIRA: SE MANDA A REVISIÓN ═══
   *
   * Llegar acá con `faltantes` significa que ni el primer intento ni el reintento le dieron
   * un veredicto a esa fila. La tentación es descartarla —es lo que hacía el código hasta
   * hoy— y es la decisión equivocada: una fila descartada no falla nada, simplemente nunca
   * aparece en la contabilidad del cliente, y nadie se entera jamás.
   *
   * Así que se arma igual, con los valores que el mapa de columnas sí permite leer, y con
   * `confidence: 0`. Eso la deja por debajo de `CONFIDENCE_THRESHOLD` y sin categoría, o sea
   * que `staging-rules` la marca y cae en revisión interna. Es la válvula que el producto ya
   * tiene, usada para lo que hace falta.
   *
   * Un humano mirando una fila de más es un costo acotado y visible. Una fila perdida es un
   * error silencioso en los números de un cliente, que es de lo que este producto no puede
   * permitirse ni uno.
   */
  for (const i of faltantes) {
    rows.push({
      targetEntity: 'transaction',
      confidence: 0,
      payload: assemblePayload({
        verdict: { i, targetEntity: 'transaction', type: null, category: null, confidence: 0 },
        row: params.rows[i]!,
        columns: columnas,
        baseCurrency: params.baseCurrency,
      }),
    });
  }

  if (faltantes.length > 0) {
    console.warn(
      `[ingesta] "${params.sheetName}": ${faltantes.length} fila(s) sin clasificar tras el ` +
        `reintento. Van a revisión interna, no se descartan.`,
    );
  }

  return {
    rows,
    columns: columnas,
    /*
     * Las filas que ni el primer intento ni el reintento cubrieron. NO se pierden: el worker
     * las manda a staging con confianza 0 para que caigan en revisión interna. Es la válvula
     * que el producto ya tiene, usada para lo que hace falta — que un humano las vea es
     * lento, pero perderlas es peor.
     */
    unclassifiedRows: faltantes,
    // `?? true` deliberado: ante la duda, procesable. El campo es `required` en el
    // esquema, pero si alguna vez faltara, el sesgo correcto es seguir clasificando —
    // el costo de tratar un archivo bueno como ilegible (se lo rebotamos al cliente)
    // es peor que el de intentar procesar uno malo (termina en revisión).
    sheetUsable: parsed.sheetUsable ?? true,
    unusableReason: parsed.unusableReason ?? null,
    inputTokens: message.usage.input_tokens,
    outputTokens: message.usage.output_tokens,
    // `?? 0`: los campos solo vienen cuando la petición lleva un bloque `cache_control`.
    // Ausente significa "no se usó caché", que numéricamente es cero — no es un dato
    // faltante que haya que distinguir.
    cacheReadTokens: message.usage.cache_read_input_tokens ?? 0,
    cacheCreationTokens: message.usage.cache_creation_input_tokens ?? 0,
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
  /** Ver `estimateCostUsd`: NO están incluidos en `inputTokens`. */
  cacheReadTokens: number;
  cacheCreationTokens: number;
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
    // `?? 0`: los campos solo vienen cuando la petición lleva un bloque `cache_control`.
    // Ausente significa "no se usó caché", que numéricamente es cero — no es un dato
    // faltante que haya que distinguir.
    cacheReadTokens: message.usage.cache_read_input_tokens ?? 0,
    cacheCreationTokens: message.usage.cache_creation_input_tokens ?? 0,
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
    // `?? 0`: los campos solo vienen cuando la petición lleva un bloque `cache_control`.
    // Ausente significa "no se usó caché", que numéricamente es cero — no es un dato
    // faltante que haya que distinguir.
    cacheReadTokens: message.usage.cache_read_input_tokens ?? 0,
    cacheCreationTokens: message.usage.cache_creation_input_tokens ?? 0,
    model: message.model,
  };
}
