import { describe, expect, test, beforeAll, afterAll, mock } from 'bun:test';
import * as XLSX from 'xlsx';
import { setupTestDatabase, ownerConnection, testOwnerUrl, testAppUrl } from './setup';

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════
 * EL ARCHIVO QUE CRECE — CU-868kt55v2
 * ═══════════════════════════════════════════════════════════════════════════════════════
 *
 * Es el flujo REAL del cliente y el criterio central del ticket: *"al resubir un archivo
 * con filas ya existentes más filas nuevas, el revenue suma solo lo nuevo, no duplica"*.
 *
 * `revert-y-recarga-e2e` ya cubre resubir el archivo IDÉNTICO. Este cubre el caso que de
 * verdad ocurre todas las semanas: el mismo libro con ventas agregadas al final. Son
 * distintos y el segundo es el que importa — un sistema puede rechazar un archivo idéntico
 * (por su hash, por ejemplo) y aun así duplicar cuando el archivo cambió una fila.
 *
 * Corre **el worker real** de principio a fin, dos veces. Solo se finge lo que sale de la
 * máquina —S3, Claude, la cola—; la base es real y las cifras se leen por el mismo camino
 * que el dashboard.
 *
 * ═══ POR QUÉ ESTE TEST EXISTE AUNQUE EL CÓDIGO YA FUNCIONE ═══
 *
 * El ticket afirma que *"el sistema hoy no deduplica las filas que ya ingirió"* y que
 * *"falta un fingerprint por fila"*. **Eso está desactualizado**: la huella por fila existe
 * desde la migración `0024` (`lib/row-fingerprint.ts` + tabla `ingested_rows`) y filtra
 * ANTES de llamar al modelo, que es justo lo que el ticket pide.
 *
 * Lo que faltaba no era el mecanismo: era una prueba que lo demostrara sobre el caso
 * incremental, para que nadie tenga que volver a averiguarlo mirando la base.
 */

process.env.DATABASE_URL = testOwnerUrl;
process.env.APP_DATABASE_URL = testAppUrl;

const HOJA = 'Ventas';
const MES = '2026-06-01';

/** Una fila = una venta. El libro de la semana 2 es el de la semana 1 MÁS filas nuevas. */
type Venta = [fecha: string, monto: number];

const SEMANA_1: Venta[] = [
  ['2026-06-02', 100],
  ['2026-06-03', 250],
  ['2026-06-04', 400],
];
const NUEVAS: Venta[] = [
  ['2026-06-10', 700],
  ['2026-06-11', 550],
];
const SEMANA_2: Venta[] = [...SEMANA_1, ...NUEVAS];

const total = (v: Venta[]) => v.reduce((s, [, m]) => s + m, 0);

let ventasDelLibro: Venta[] = SEMANA_1;

function libro(): Buffer {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.aoa_to_sheet([['fecha', 'monto'], ...ventasDelLibro]),
    HOJA,
  );
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}

/**
 * Cuántas filas DE DATOS se le mandaron al modelo en la última corrida. Es la mitad del
 * criterio del ticket: *"idealmente, las filas ya existentes no se mandan a la IA"*.
 *
 * Se cuentan solo las que traen un monto numérico y NO la fila de encabezado, que el worker
 * incluye en el lote a propósito — sus índices tienen que seguir apuntando a la fila 0 de la
 * hoja (ver la nota de `lib/sheet-header.ts` en CLAUDE.md). Contar el encabezado mezclaría
 * un detalle del protocolo con lo que acá se mide, que es cuántas ventas se pagan de nuevo.
 */
let filasAlModelo = 0;

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

const anthropicReal = await import('@/lib/anthropic');

mock.module('@/lib/anthropic', () => ({
  ...anthropicReal,
  classifySheetRows: async (params: { rows: unknown[][] }) => {
    filasAlModelo += params.rows.filter((r) => typeof r[1] === 'number').length;
    const filas = params.rows.map((row) => ({
      targetEntity: 'transaction' as const,
      payload: {
        type: 'revenue',
        category: 'ventas',
        date: String(row[0]),
        originalAmount: Number(row[1]),
        originalCurrency: 'GTQ',
      },
      confidence: 0.95,
    }));
    return {
      model: 'claude-sonnet-5',
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      columns: {
        date: 0,
        amount: 1,
        currency: null,
        description: null,
        counterparty: null,
        product: null,
        quantity: null,
        productCategory: null,
        store: null,
        dueDate: null,
        costTotal: null,
        costUnit: null,
      },
      unclassifiedRows: [],
      sheetUsable: true,
      unusableReason: null,
      /*
       * El modelo clasifica CADA fila que le llegó. Si el filtro no funcionara, acá se
       * vería: llegarían las cinco en la segunda carga en vez de las dos nuevas.
       *
       * El payload se arma con los valores de LA FILA que llegó, no con constantes: así el
       * total del dashboard depende de qué filas pasaron el filtro, que es exactamente lo
       * que este test mide. Con un monto fijo, duplicar y no duplicar darían lo mismo.
       */
      rows: filas,
      veredictos: veredictosDe(filas),
    };
  },
  estimateCostUsd: () => 0.001,
  DEFAULT_INSIGHT_PROMPT: '',
}));

mock.module('@/lib/s3', () => ({ downloadObject: async () => libro() }));

type Handler = (payload: { documentId: string; companyId: string }) => Promise<void>;
let handler: Handler | undefined;

mock.module('@/queue', () => ({
  QUEUES: { excelIngest: 'excel.ingest', alertEvaluate: 'alert.evaluate' },
  enqueue: async () => null,
  registerWorker: async (_q: string, h: Handler) => {
    handler = h;
    return 'worker-id';
  },
}));

const { startExcelIngestWorker } = await import('@/queue/workers/excel-ingest');
const { getOrComputeMonthlyAmounts } = await import('@/lib/rollups');
const { drizzle } = await import('drizzle-orm/postgres-js');
const schema = await import('@/db/schema');

const owner = ownerConnection();
let companyId: string;
let userId: string;

beforeAll(async () => {
  await setupTestDatabase();

  const [c] = await owner`
    insert into companies (workos_org_id, name, industry, base_currency)
    values ('wos_incremental', 'Incremental SA', 'retail', 'GTQ') returning id
  `;
  companyId = c!.id;
  await owner.unsafe(
    `create table if not exists "transactions_${companyId.replace(/-/g, '_')}"
       partition of transactions for values in ('${companyId}')`,
  );

  const [u] = await owner`
    insert into users (workos_user_id, email)
    values ('wos_incremental_u', 'incremental@test.local') returning id
  `;
  userId = u!.id;

  await startExcelIngestWorker();
});

afterAll(async () => {
  await owner?.end();
});

async function subir(nombre: string): Promise<string> {
  const [d] = await owner`
    insert into documents (company_id, uploaded_by, s3_key, original_filename,
                           file_size_bytes, mime_type, status)
    values (${companyId}, ${userId}, ${`${companyId}/${nombre}`}, ${nombre},
            100, 'text/csv', 'queued')
    returning id
  `;
  const documentId = d!.id;
  await handler!({ documentId, companyId });
  return documentId;
}

const ingreso = async (): Promise<number> => {
  const db = drizzle(owner, { schema }) as never;
  const m = await getOrComputeMonthlyAmounts(db, companyId, [MES]);
  return m.get(MES)!.revenue;
};

const contarTx = async (): Promise<number> => {
  const [r] = await owner`
    select count(*)::int as n from transactions
    where company_id = ${companyId} and deleted_at is null
  `;
  return r!.n;
};

describe('resubir el mismo archivo con ventas agregadas', () => {
  test('1) la primera semana entra completa', async () => {
    ventasDelLibro = SEMANA_1;
    filasAlModelo = 0;

    await subir('ventas-semana-1.xlsx');

    expect(await contarTx()).toBe(SEMANA_1.length);
    expect(await ingreso()).toBe(total(SEMANA_1));
    expect(filasAlModelo).toBe(SEMANA_1.length);
  });

  test('2) la segunda semana suma SOLO lo nuevo, no duplica', async () => {
    /*
     * ═══ EL CRITERIO DEL TICKET ═══
     *
     * Si la deduplicación no filtrara, acá habría 8 transacciones (3 + 5) y el ingreso
     * sería 750 + 2000 = 2750 en vez de 2000. Es exactamente la forma del reporte de
     * Macha: 4,4M donde debía haber 2,8M.
     */
    ventasDelLibro = SEMANA_2;
    filasAlModelo = 0;

    await subir('ventas-semana-2.xlsx');

    expect(await contarTx()).toBe(SEMANA_2.length);
    expect(await ingreso()).toBe(total(SEMANA_2));
  });

  test('3) y las filas repetidas NO se le mandan al modelo', async () => {
    /*
     * La otra mitad del criterio, y la que se paga en dinero: *"idealmente, las filas ya
     * existentes no se mandan a la IA"*. El cliente resube su contabilidad entera cada
     * semana; si el filtro corriera DESPUÉS del modelo, el total saldría bien y el recibo
     * de Anthropic crecería igual, sin que nada lo delatara.
     *
     * La aserción es sobre la corrida anterior: dos filas nuevas, no cinco.
     */
    expect(filasAlModelo).toBe(NUEVAS.length);
  });

  test('4) una tercera carga del MISMO libro ya no aporta nada', async () => {
    // El caso del cliente que sube dos veces por error, o que reintenta.
    filasAlModelo = 0;
    await subir('ventas-semana-2-otra-vez.xlsx');

    expect(await contarTx()).toBe(SEMANA_2.length);
    expect(await ingreso()).toBe(total(SEMANA_2));
    expect(filasAlModelo).toBe(0);
  });
});
