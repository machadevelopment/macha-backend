import { describe, expect, test, beforeAll, afterAll, mock } from 'bun:test';
import * as XLSX from 'xlsx';
import { setupTestDatabase, ownerConnection, testOwnerUrl, testAppUrl } from './setup';
import { crearDobleDeCola } from './doble-de-cola';
import { confirmarYPromover } from './confirmar-carga';

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * EL CUADRE, CONTRA POSTGRES DE VERDAD
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *
 * `lib/cuadre.test.ts` prueba la ARITMÉTICA con números a mano. Este archivo prueba lo otro,
 * que es lo que de verdad puede fallar y no se ve en un test unitario:
 *
 *   · que lo LEÍDO se acumule de verdad, por moneda, mientras el worker procesa;
 *   · que lo ATERRIZADO se lea de las TRES tablas del ledger —`transactions`, `invoices` y
 *     `bills`—, porque olvidar una haría que toda carga de facturas pareciera un descuadre;
 *   · que la EXPANSIÓN salga de filas reales del ledger y no de una constante;
 *   · y que un fallo del propio cuadre NO tumbe la carga.
 *
 * El motivo de fondo: un chequeo que nunca corrió contra la base no está probado. Y este
 * chequeo es lo único que detecta un fallo en un archivo que nadie vio nunca, así que si él
 * mismo está roto, la red de seguridad no existe y nadie lo sabría.
 *
 * Corre el worker real contra Postgres real. Solo se finge lo que sale de la máquina.
 */

process.env.DATABASE_URL = testOwnerUrl;
process.env.APP_DATABASE_URL = testAppUrl;

/**
 * El libro: una hoja de FACTURAS.
 *
 * Se eligió esa forma a propósito y no una de ventas simples: una factura produce DOS filas de
 * ledger (la `invoice` y su ingreso devengado), así que ejercita la expansión — que es la
 * parte del cuadre que un test con ventas planas dejaría sin probar.
 */
const FACTURAS: [fecha: string, cliente: string, monto: number][] = Array.from(
  { length: 12 },
  (_, i) => [`2026-07-${String(i + 1).padStart(2, '0')}`, `Cliente ${i % 4}`, 1000 + i * 100],
);
const TOTAL_FACTURADO = FACTURAS.reduce((s, [, , m]) => s + m, 0);

function libro(): Buffer {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.aoa_to_sheet([['fecha', 'cliente', 'monto'], ...FACTURAS]),
    'Facturacion',
  );
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}

const MAPA = {
  date: 0, amount: 2, currency: null, description: null, counterparty: 1, product: null,
  quantity: null, productCategory: null, store: null, dueDate: null, costTotal: null,
  costUnit: null,
}; // prettier-ignore

const anthropicReal = await import('@/lib/anthropic');

/** El doble clasifica todo como `invoice`, que es lo que haría el modelo con esta hoja. */
mock.module('@/lib/anthropic', () => ({
  ...anthropicReal,
  classifySheetRows: async (params: { rows: unknown[][] }) => {
    const veredictos = params.rows.map((row) =>
      typeof row[2] === 'number' && typeof row[0] === 'string' && row[0].startsWith('2026')
        ? { e: 'invoice' as const, t: null, c: 'facturacion', cf: 0.95 }
        : { e: 'skip' as const, t: null, c: null, cf: 0 },
    );
    /*
     * Se llama a `construirFilas` REAL en vez de fabricar las filas a mano: es lo que deriva
     * el ingreso de cada factura, o sea justamente la expansión que este test mide. Fabricarlas
     * a mano probaría el test contra sí mismo.
     */
    const porIndice = new Map(
      veredictos.map((v, i) => [i, { i, e: v.e, t: v.t, c: v.c, cf: v.cf }]),
    );
    return {
      model: 'claude-sonnet-5',
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      columns: MAPA,
      unclassifiedRows: [],
      sheetUsable: true,
      unusableReason: null,
      veredictos,
      rows: anthropicReal.construirFilas(
        porIndice as never,
        { rows: params.rows, baseCurrency: 'GTQ' },
        MAPA as never,
      ),
    };
  },
  estimateCostUsd: () => 0.001,
  DEFAULT_INSIGHT_PROMPT: '',
}));

const s3Real = await import('@/lib/s3');
mock.module('@/lib/s3', () => ({ ...s3Real, downloadObject: async () => libro() }));

type Handler = (p: { documentId: string; companyId: string }) => Promise<void>;
let handler: Handler | undefined;
const dobleDeCola = crearDobleDeCola();
mock.module('@/queue', () => ({
  ...dobleDeCola.modulo,
  registerWorker: async (queue: string, h: Handler) => {
    handler = h;
    return dobleDeCola.modulo.registerWorker(queue, h as never);
  },
}));

/** Lo que el worker escribió en el log del cuadre, para poder afirmar sobre el veredicto. */
const lineasDeCuadre: string[] = [];
const infoReal = console.info;
const warnReal = console.warn;
console.info = (...a: unknown[]) => {
  const s = a.map(String).join(' ');
  if (s.includes('[cuadre]')) lineasDeCuadre.push(s);
  infoReal(...(a as []));
};
console.warn = (...a: unknown[]) => {
  const s = a.map(String).join(' ');
  if (s.includes('[cuadre]')) lineasDeCuadre.push(s);
  warnReal(...(a as []));
};

const { startExcelIngestWorker } = await import('@/queue/workers/excel-ingest');

const owner = ownerConnection();
let companyId: string;
let documentId: string;

beforeAll(async () => {
  await setupTestDatabase();
  const [c] = await owner`
    insert into companies (workos_org_id, name, industry, base_currency)
    values ('wos_cuadre', 'Cuadre SA', 'servicios', 'GTQ') returning id
  `;
  companyId = c!.id;
  const sufijo = companyId.replace(/-/g, '_');
  for (const tabla of ['transactions', 'invoices', 'bills']) {
    await owner.unsafe(
      `create table if not exists "${tabla}_${sufijo}"
         partition of ${tabla} for values in ('${companyId}')`,
    );
  }
  const [u] = await owner`
    insert into users (workos_user_id, email)
    values ('wos_cuadre_u', 'cuadre@test.local') returning id
  `;
  await startExcelIngestWorker();
  const [d] = await owner`
    insert into documents (company_id, uploaded_by, s3_key, original_filename,
                           file_size_bytes, mime_type, status)
    values (${companyId}, ${u!.id}, ${`${companyId}/fac.xlsx`}, 'fac.xlsx',
            100, 'text/csv', 'queued')
    returning id
  `;
  documentId = d!.id;
  await handler!({ documentId, companyId });
  // El portón (migración 0042): el dueño confirma y recién ahí entra al ledger.
  await confirmarYPromover(owner, companyId, documentId);
});

afterAll(async () => {
  console.info = infoReal;
  console.warn = warnReal;
  await owner?.end();
});

const unNumero = async (q: Promise<{ n: number }[]>): Promise<number> => (await q)[0]!.n;

describe('el cuadre corre de verdad al terminar la carga', () => {
  test('la carga produjo las DOS filas por factura: la deuda y el ingreso', async () => {
    /*
     * Guardia del propio test. Si la derivación del ingreso dejara de ocurrir, no habría
     * expansión que medir y todo lo de abajo pasaría sin probar nada.
     */
    const facturas = await unNumero(
      owner`select count(*)::int as n from invoices where document_id = ${documentId}`,
    );
    const ingresos = await unNumero(
      owner`select count(*)::int as n from transactions where document_id = ${documentId}`,
    );
    expect(facturas).toBe(FACTURAS.length);
    expect(ingresos).toBe(FACTURAS.length);
  });

  test('el cuadre se evaluó y dejó su veredicto en el log', () => {
    // Si esto falla, el lazo volvió a quedar abierto: la medición existe y nadie la compara.
    expect(lineasDeCuadre.length).toBeGreaterThan(0);
  });

  test('una carga NORMAL con expansión legítima NO se reporta como descuadre', () => {
    /*
     * Es la mitad que hace usable el detector: si marcara cada carga normal, nadie lo miraría
     * y daría igual que existiera.
     *
     * Acá aterriza 2× lo leído —la factura y su ingreso— y eso es exactamente lo que el
     * pipeline declaró que iba a producir, así que la cota se calcula en 2,3 y no dispara.
     */
    expect(lineasDeCuadre.some((l) => l.includes('DESCUADRE'))).toBe(false);
    expect(lineasDeCuadre.some((l) => l.includes('cuadra'))).toBe(true);
  });

  test('lo aterrizado incluye las TRES tablas del ledger, no solo transactions', () => {
    /*
     * Olvidar `invoices` o `bills` haría que toda carga de facturas pareciera un descuadre por
     * exceso, y el detector se volvería ruido que nadie mira. Se comprueba por la cifra: el
     * total reportado tiene que ser el de las dos tablas juntas.
     */
    const linea = lineasDeCuadre.find((l) => l.includes('cuadra'))!;
    expect(linea).toContain((TOTAL_FACTURADO * 2).toFixed(2));
  });

  test('lo leído del archivo quedó registrado con su cifra real', () => {
    const linea = lineasDeCuadre.find((l) => l.includes('cuadra'))!;
    expect(linea).toContain(TOTAL_FACTURADO.toFixed(2));
  });

  test('la carga terminó bien: el cuadre no la tocó', async () => {
    // Un fallo del chequeo no puede costar la contabilidad del cliente.
    const [doc] = await owner`select status from documents where id = ${documentId}`;
    expect(['promoted', 'review']).toContain(doc!.status);
  });
});
