import { describe, expect, test, beforeAll, afterAll, mock } from 'bun:test';
import * as XLSX from 'xlsx';
import { setupTestDatabase, ownerConnection, testOwnerUrl, testAppUrl } from './setup';
import { crearDobleDeCola } from './doble-de-cola';
import { confirmarYPromover } from './confirmar-carga';

/**
 * CU-868kkgypv criterio 3: un fallo a media ejecución seguido de reintento no puede
 * duplicar nada.
 *
 * Se ejercita el worker DE VERDAD, no una reimplementación: se captura su handler
 * mockeando `registerWorker` y se le llama dos veces, igual que haría pg-boss al
 * reintentar. Lo único que se sustituye es lo que sale de la máquina —S3, Claude— y la
 * cola. La base es real y se cuentan filas, no estado interno (criterio 3).
 *
 * El escenario es el del ticket: dos hojas, la llamada a Claude de la SEGUNDA falla en el
 * primer intento. Antes de este ticket, el reintento volvía a procesar la hoja 1 y dejaba
 * `staging_rows` duplicadas (y transacciones dobles al promover), un segundo débito de
 * créditos sobre un ledger append-only y el `cost_usd` inflado.
 */

process.env.DATABASE_URL = testOwnerUrl;
process.env.APP_DATABASE_URL = testAppUrl;

const HOJA_A = 'Ventas';
const HOJA_B = 'Costos';

/** Filas de entrada por hoja. Muy por debajo del umbral de lote: 1 lote por hoja. */
const FILAS_A = [
  ['fecha', 'monto'],
  ['2019-05-01', 100],
];
const FILAS_B = [
  ['fecha', 'monto'],
  ['2019-05-02', 200],
];

function libroDeDosHojas(): Buffer {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(FILAS_A), HOJA_A);
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(FILAS_B), HOJA_B);
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}

/** Una fila limpia (confianza alta y payload válido) para que la promoción ocurra. */
const filaLimpia = (fecha: string, monto: number) => ({
  targetEntity: 'transaction' as const,
  payload: {
    type: 'revenue',
    category: 'ventas',
    date: fecha,
    originalAmount: monto,
    originalCurrency: 'GTQ',
  },
  confidence: 0.95,
});

/**
 * Los veredictos crudos que acompañan a las filas clasificadas.
 *
 * `classifySheetRows` los devuelve para que el worker mida si la hoja es HOMOGÉNEA y pueda
 * dejar de llamar al modelo (`lib/sheet-consensus.ts`). Se derivan de las filas que este
 * doble ya produce en vez de ponerse a mano: un `[]` fijo compilaría igual y haría creer al
 * consenso que el lote no trajo filas, o sea que probaría el camino equivocado el día que
 * este test crezca a tres lotes.
 */
type FilaClasificada = {
  targetEntity: 'transaction' | 'invoice' | 'bill';
  payload: Record<string, unknown>;
  confidence: number;
};
const veredictosDe = (filas: FilaClasificada[]) =>
  filas.map((f) => ({
    e: f.targetEntity,
    t: (f.payload.type ?? null) as 'revenue' | 'cogs' | 'opex' | 'other' | null,
    c: (f.payload.category ?? null) as string | null,
    cf: f.confidence,
  }));

/** El mapa que "devuelve" el modelo. Igual para las dos hojas: el caso normal. */
const MAPA_DE_COLUMNAS = {
  date: 0,
  amount: 1,
  currency: null,
  description: null,
  counterparty: null,
  product: null,
  quantity: null,
  productCategory: null,
  dueDate: null,
};

/** Llamadas a Claude, por hoja. Es la prueba de que un lote hecho no se repite. */
const llamadas: string[] = [];
let fallarEnHojaB = true;

/*
 * Se parte del módulo REAL y solo se pisa lo que este test necesita fingir (la llamada a
 * Claude y el costo). Listar los exports a mano era frágil de una forma concreta y ya
 * comprobada: al agregar `assertMismoMapa` al worker, este test se cayó con
 * "Export named 'assertMismoMapa' not found" — el mock había quedado desactualizado sin que
 * nadie lo tocara, y el fallo no tenía nada que ver con lo que el test prueba.
 *
 * Importar el real es seguro: `getClient()` es perezoso y la API key es opcional en `env`.
 */
const anthropicReal = await import('@/lib/anthropic');

mock.module('@/lib/anthropic', () => ({
  ...anthropicReal,
  classifySheetRows: async ({ sheetName }: { sheetName: string }) => {
    llamadas.push(sheetName);
    if (sheetName === HOJA_B && fallarEnHojaB) {
      // El fallo realista: Anthropic devuelve 529 / se agota el rate limit.
      throw new Error('Anthropic 529 overloaded');
    }
    const filas = [
      sheetName === HOJA_A ? filaLimpia('2019-05-01', 100) : filaLimpia('2019-05-02', 200),
    ];
    return {
      model: 'claude-sonnet-5',
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      // Las dos hojas devuelven el MISMO mapa: `assertMismoMapa` (el real, no un stub) corre
      // sobre esto, así que si alguna vez se rompiera el guardia, este test lo notaría.
      columns: MAPA_DE_COLUMNAS,
      unclassifiedRows: [],
      sheetUsable: true,
      unusableReason: null,
      rows: filas,
      veredictos: veredictosDe(filas),
    };
  },
  estimateCostUsd: () => 0.001,
  DEFAULT_INSIGHT_PROMPT: '',
}));

/*
 * `mock.module` es GLOBAL al proceso, no al archivo: la suite de integración corre en una sola
 * invocación de `bun test`, así que este doble reemplaza `@/lib/s3` para TODOS los archivos.
 *
 * De ahí el spread del módulo real. Sin él, el mock no "agrega" `downloadObject`: BORRA todo lo
 * demás que el módulo exporta, y cualquier archivo que importe `uploadKey` u `uploadObject`
 * revienta con `SyntaxError: Export named 'uploadKey' not found` — un error de importación que
 * no menciona ni este archivo ni este mock. Pasó exactamente así al agregar
 * `conceptos-del-cliente.test.ts`, que monta el módulo de ingesta completo.
 */
const s3Real = await import('@/lib/s3');
mock.module('@/lib/s3', () => ({
  ...s3Real,
  downloadObject: async () => libroDeDosHojas(),
}));

// Se captura el handler que el worker registra: es la forma de invocarlo igual que
// pg-boss sin levantar pg-boss.
type Handler = (payload: { documentId: string; companyId: string }) => Promise<void>;
let handler: Handler | undefined;

/*
 * El doble de la cola es COMPARTIDO (`./doble-de-cola`) y no local, porque `mock.module` es
 * global al proceso: cinco archivos lo doblaban por separado, cada uno con los dos o tres
 * exports que él usaba, y el último en cargarse ganaba. Al montar un módulo que importa
 * `RETRY_POLICY` eso se volvió `SyntaxError: Export named 'RETRY_POLICY' not found` — en CI
 * y no en local, porque el orden de carga no es el mismo. Ver la nota del ayudante.
 */
const dobleDeCola = crearDobleDeCola();
mock.module('@/queue', () => ({
  ...dobleDeCola.modulo,
  registerWorker: async (queue: string, h: Handler) => {
    handler = h;
    return dobleDeCola.modulo.registerWorker(queue, h as never);
  },
}));

const { startExcelIngestWorker } = await import('@/queue/workers/excel-ingest');

const owner = ownerConnection();
let companyId: string;
let documentId: string;

beforeAll(async () => {
  await setupTestDatabase();

  const [c] = await owner`
    insert into companies (workos_org_id, name, industry, base_currency)
    values ('wos_retry_org', 'Reintentos SA', 'retail', 'GTQ') returning id
  `;
  companyId = c!.id;

  // `transactions` está particionada por LIST (company_id): sin partición el INSERT de
  // la promoción falla. En producción lo hace `provisionTenantPartitions`.
  const suffix = companyId.replace(/-/g, '_');
  await owner.unsafe(
    `create table if not exists "transactions_${suffix}" partition of transactions
       for values in ('${companyId}')`,
  );

  const [t] = await owner`
    insert into industry_templates (industry, name) values ('retail', 'Retail') returning id
  `;
  const [u] = await owner`
    insert into users (workos_user_id, email)
    values ('wos_retry', 'retry@test.local') returning id
  `;
  const [tv] = await owner`
    insert into industry_template_versions (template_id, version, synonyms, few_shot, created_by)
    values (${t!.id}, 1, '{}'::jsonb, '[]'::jsonb, ${u!.id}) returning id
  `;
  await owner`update industry_templates set current_version_id = ${tv!.id} where id = ${t!.id}`;

  /*
   * La regla REAL de producción: `fixed`, 25 créditos. No la del seed (`variable`, 1 por
   * lote), y la diferencia es justamente lo que ocultaba el bug — con 1 crédito, cobrar por
   * lote y cobrar por carga se distinguen por un número que se lee como redondeo.
   *
   * Y `fixed` deja el defecto a la vista: `estimateRequiredCredits` devuelve 25 SIEMPRE, sin
   * mirar cuántas unidades se le pasen. O sea que la regla ya decía "25 por carga"; lo que
   * estaba mal era llamarla una vez por lote. Un archivo de 77 lotes cobraba 1.925.
   */
  await owner`
    insert into credit_rules (action_kind, rule_type, credits_per_unit, version, active)
    values ('excel', 'fixed', 25, 1, true)
  `;

  const [d] = await owner`
    insert into documents (company_id, uploaded_by, s3_key, original_filename,
                           file_size_bytes, mime_type)
    values (${companyId}, ${u!.id}, ${`${companyId}/x`}, 'x.xlsx', 100,
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    returning id
  `;
  documentId = d!.id;

  await startExcelIngestWorker();
});

afterAll(async () => {
  await owner.end();
});

const contar = async (tabla: string): Promise<number> => {
  const rows = await owner.unsafe(
    `select count(*)::int as n from ${tabla} where document_id = '${documentId}'`,
  );
  return (rows[0] as { n: number }).n;
};

describe('reintento de excel.ingest tras un fallo a media ejecución', () => {
  test('el primer intento falla en la hoja 2 y deja la hoja 1 confirmada', async () => {
    expect(handler).toBeDefined();
    await expect(handler!({ documentId, companyId })).rejects.toThrow('529');

    // La hoja 1 sí se procesó y quedó confirmada; la 2 no dejó nada.
    expect(await contar('document_ingest_batches')).toBe(1);
    expect(await contar('staging_rows')).toBe(1);
    /*
     * Se compara como CONJUNTO, no como secuencia: los lotes van a Claude en paralelo
     * (`intakeConfig.batchConcurrency`), así que el orden entre hojas nunca estuvo
     * garantizado — era estable por accidente.
     *
     * Lo confirmó agregar la consulta de cancelación antes de cada lote: ese `await` de más
     * cambió qué tarea llega primero y el test empezó a fallar por `["Costos","Ventas"]`,
     * sin que nada de lo que el test dice probar hubiera cambiado.
     *
     * Lo que importa acá es CUÁLES hojas se llamaron y cuántas veces, no en qué orden.
     */
    expect([...llamadas].sort()).toEqual([HOJA_A, HOJA_B].sort());
  });

  test('el reintento NO vuelve a llamar a Claude por la hoja ya procesada', async () => {
    fallarEnHojaB = false;
    llamadas.length = 0;

    await handler!({ documentId, companyId });
    // El portón (migración 0042): el dueño confirma y recién ahí entra al ledger.
    await confirmarYPromover(owner, companyId, documentId);

    // Solo la hoja que faltaba. Esto es lo que ahorra el gasto real en Anthropic.
    expect(llamadas).toEqual([HOJA_B]);
  });

  test('criterio 1: no se duplican staging_rows, créditos ni costo de IA', async () => {
    expect(await contar('staging_rows')).toBe(2); // una por hoja, no tres
    expect(await contar('document_ingest_batches')).toBe(2);

    /*
     * ═══ UN DÉBITO POR CARGA, NO POR LOTE (reporte de Jose, 2026-08-24) ═══
     *
     * Este test afirmaba `n = 2` —"un débito por lote"— y pasaba porque el código hacía lo que
     * el código hacía: fijaba la implementación, no lo que el cliente debe pagar. Con la regla
     * real de 25 créditos, ese "por lote" cobraba 1.925 por un archivo de 77 lotes y dejaba a
     * Electro Hogar en -1.675 con su primera carga.
     *
     * El documento tiene DOS lotes y aun así paga UNA vez. Y el reintento, que es lo que este
     * archivo prueba, tampoco vuelve a cobrar: la idempotencia por lote la daba
     * `document_ingest_batches`; ahora la da `cargaYaDebitada`.
     */
    const [cred] = await owner`
      select count(*)::int as n, coalesce(sum(delta), 0)::int as total
      from credit_transactions where ref_id = ${documentId}
    `;
    expect(cred!.n).toBe(1);
    expect(cred!.total).toBe(-25);

    const [ia] = await owner`
      select count(*)::int as n from ai_usage_events where ref_id = ${documentId}
    `;
    expect(ia!.n).toBe(2);
  });

  test('criterio 2: la promoción crea las filas de una sola ejecución', async () => {
    const [tx] = await owner`
      select count(*)::int as n from transactions where document_id = ${documentId}
    `;
    expect(tx!.n).toBe(2);

    const [doc] = await owner`
      select status, row_count from documents where id = ${documentId}
    `;
    expect(doc!.status).toBe('promoted');
    // Ojo con qué mide `row_count`: al promover, `promoteDocument` lo fija con las filas
    // de STAGING promovidas (2, una por hoja), no con las filas de entrada leídas del
    // Excel (4, contando cabeceras). La rama de `review` sí guarda las de entrada. Esa
    // ambigüedad es previa a este ticket y no se toca aquí; se deja anotada porque el
    // número engaña si se lee sin saberlo.
    expect(doc!.row_count).toBe(2);
  });
});
