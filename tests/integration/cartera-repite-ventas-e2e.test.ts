import { describe, expect, test, beforeAll, afterAll, mock } from 'bun:test';
import { randomUUID } from 'node:crypto';
import * as XLSX from 'xlsx';
import { setupTestDatabase, ownerConnection, testOwnerUrl, testAppUrl } from './setup';
import { crearDobleDeCola } from './doble-de-cola';

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA CARTERA QUE REPITE LAS VENTAS, CONTRA EL WORKER DE VERDAD
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *
 * Encontrado probando de punta a punta en producción con un archivo real de cliente
 * (`Jewelry_Store_Template11`, 2026-09-03): su `Accounts Receivable` son las MISMAS ventas de
 * `Sales Orders`, facturadas. Cada venta se contaba dos veces —una como venta y otra como
 * factura devengando su ingreso— y el dashboard mostró **268.195 sobre 140.045 reales, +91 %**.
 *
 * ⚠️ ESTE TEST EXISTE PORQUE EL UNITARIO NO ALCANZABA, y esa es su razón de ser. Mutar el
 * worker para que ignore la segunda vía de detección dejaba la suite de integración ENTERA en
 * verde: ningún test pasaba por el worker con esta forma de libro. Es el mismo error que este
 * repo ya pagó con `mapaDelLote` y con `aplicarEntidadForzada` — medir la función y no el
 * lugar donde se usa.
 *
 * ⚠️ Y lo que se afirma NO es que la hoja desaparezca. La factura se crea igual —el cliente
 * necesita su cartera en Por cobrar— y lo único que no ocurre es el devengo por segunda vez.
 * Si esto se "arreglara" descartando la hoja, Por cobrar quedaría en cero, que es el bug de
 * U3TECH; por eso el test mide las DOS cosas.
 */

process.env.DATABASE_URL = testOwnerUrl;
process.env.APP_DATABASE_URL = testAppUrl;

/*
 * ⚠️ DIEZ clientes y no tres, y eso lo destapó este mismo test: con tres, `Cust. ID` tiene
 * cardinalidad de CLAVE y el esquema del libro declara `Sales Orders` tabla de entidades — se
 * iba entera al inventario. El archivo real tiene ~10 clientes en 171 ventas, así que el
 * fixture con tres no representaba nada y medía otro camino del pipeline.
 */
const CLIENTES = Array.from({ length: 10 }, (_, i) => `CU-${String(i + 1).padStart(3, '0')}`);
/*
 * ⚠️ Los precios se REPITEN, como en cualquier catálogo real, y eso también lo destapó este
 * test: con 24 montos todos distintos, `analizarEsquema` toma la columna de dinero como CLAVE
 * FORÁNEA —`Invoice Amount` → `Total`, cobertura 1.00— y declara `Sales Orders` tabla de
 * entidades: se iba entera al inventario. Una joyería vende el mismo anillo varias veces; un
 * fixture con montos únicos no representa ningún archivo.
 */
const PRECIOS = [440, 130, 950, 585, 1850, 275];
const MONTOS = Array.from({ length: 24 }, (_, i) => PRECIOS[i % PRECIOS.length]!);
/** Solo 9 de las 12 ventas se facturaron: los TOTALES no empatan, y por eso hace falta la
 *  comparación fila por fila. El dedup por totales no puede ver esto. */
const FACTURADAS = 18;

const TOTAL_VENTAS = MONTOS.reduce((s, m) => s + m, 0);
const TOTAL_CARTERA = MONTOS.slice(0, FACTURADAS).reduce((s, m) => s + m, 0);

function libro(): Buffer {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.aoa_to_sheet([
      ['Order #', 'Order Date', 'Cust. ID', 'Customer Name', 'Total'],
      ...MONTOS.map((m, i) => [
        `SO-${2001 + i}`,
        46027 + i,
        CLIENTES[i % 10],
        `Cliente ${i % 10}`,
        m,
      ]),
    ]),
    'Sales Orders',
  );
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.aoa_to_sheet([
      ['Invoice #', 'Cust. ID', 'Invoice Date', 'Due Date', 'Invoice Amount'],
      ...MONTOS.slice(0, FACTURADAS).map((m, i) => [
        `INV-${6001 + i}`,
        CLIENTES[i % 10],
        46027 + i,
        46057 + i,
        m,
      ]),
    ]),
    'Accounts Receivable',
  );
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}

const MAPA_VENTAS = {
  date: 1, amount: 4, currency: null, description: null, counterparty: 3, product: null,
  quantity: null, productCategory: null, store: null, dueDate: null, costTotal: null,
  costUnit: null,
}; // prettier-ignore
const MAPA_CARTERA = { ...MAPA_VENTAS, date: 2, amount: 4, counterparty: 1, dueDate: 3 };

const anthropicReal = await import('@/lib/anthropic');
mock.module('@/lib/anthropic', () => ({
  ...anthropicReal,
  /*
   * ⚠️ El doble RECIBE `ventaYaRegistradaEnOtraHoja` y se lo pasa a `construirFilas`. Sin eso
   * este test no mide nada: `classifySheetRows` está doblada entera, así que las banderas que
   * el worker calcula no llegarían al armado y la cartera devengaría igual — con el log
   * diciendo "No devenga de nuevo". Fue exactamente lo que pasó en el primer intento.
   */
  classifySheetRows: async (params: {
    rows: unknown[][];
    sheetName: string;
    ventaYaRegistradaEnOtraHoja?: boolean;
  }) => {
    const cartera = params.sheetName === 'Accounts Receivable';
    const columns = cartera ? MAPA_CARTERA : MAPA_VENTAS;
    const col = cartera ? 4 : 4;
    const veredictos = params.rows.map((row) =>
      typeof (row as unknown[])[col] === 'number'
        ? {
            e: (cartera ? 'invoice' : 'transaction') as 'invoice' | 'transaction',
            t: 'revenue' as const,
            c: 'ventas',
            cf: 0.95,
          }
        : { e: 'skip' as const, t: null, c: null, cf: 0 },
    );
    const porIndice = new Map(
      veredictos.map((v, i) => [i, { i, e: v.e, t: v.t, c: v.c, cf: v.cf }]),
    );
    return {
      model: 'claude-sonnet-5',
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      columns,
      unclassifiedRows: [],
      sheetUsable: true,
      unusableReason: null,
      veredictos,
      rows: anthropicReal.construirFilas(
        porIndice as never,
        {
          rows: params.rows,
          baseCurrency: 'GTQ',
          ventaYaRegistradaEnOtraHoja: params.ventaYaRegistradaEnOtraHoja,
        },
        columns as never,
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

const { startExcelIngestWorker } = await import('@/queue/workers/excel-ingest');

const SUFIJO = randomUUID().slice(0, 8);
const owner = ownerConnection();
let companyId: string;
let documentId: string;

const sumaDe = async (hoja: string, entidad: string) =>
  Number(
    (
      await owner`
        select coalesce(sum((payload->>'originalAmount')::numeric), 0) as t
          from staging_rows
         where document_id = ${documentId} and sheet_name = ${hoja}
           and target_entity = ${entidad}`
    )[0]!.t,
  );

beforeAll(async () => {
  await setupTestDatabase();
  const [c] = await owner`
    insert into companies (workos_org_id, name, industry, base_currency)
    values (${`wos_cart_${SUFIJO}`}, ${`Cartera ${SUFIJO}`}, 'retail', 'GTQ') returning id`;
  companyId = c!.id;
  const [u] = await owner`
    insert into users (workos_user_id, email)
    values (${`wos_cart_u_${SUFIJO}`}, ${`cart-${SUFIJO}@test.local`}) returning id`;
  await startExcelIngestWorker();
  const [d] = await owner`
    insert into documents (company_id, uploaded_by, s3_key, original_filename,
                           file_size_bytes, mime_type, status)
    values (${companyId}, ${u!.id}, ${`${companyId}/cartera.xlsx`}, 'cartera.xlsx',
            100, 'text/csv', 'queued')
    returning id`;
  documentId = d!.id;
  await handler!({ documentId, companyId });
});

afterAll(async () => {
  await owner?.end();
});

describe('la cartera que repite las ventas no devenga otra vez', () => {
  test('el INGRESO es el de las ventas, no el doble', async () => {
    /*
     * La afirmación que importa. Sin la guarda serían TOTAL_VENTAS + TOTAL_CARTERA, que es el
     * +91 % medido en producción sobre el archivo real.
     */
    const ingreso = await sumaDe('Sales Orders', 'transaction');
    const devengado = await sumaDe('Accounts Receivable', 'transaction');
    expect(ingreso).toBe(TOTAL_VENTAS);
    expect(devengado).toBe(0);
  });

  test('⚠️ y la CARTERA sigue existiendo: no se descarta la hoja', async () => {
    /*
     * La otra mitad, y la que hace que este arreglo no sea el bug de U3TECH: el cliente
     * necesita ver a quién le deben. Descartar la hoja dejaría Por cobrar en cero.
     */
    const facturas = await sumaDe('Accounts Receivable', 'invoice');
    expect(facturas).toBe(TOTAL_CARTERA);
  });

  test('los TOTALES no empatan, así que el dedup viejo no podía verlo', () => {
    // Es la razón por la que hizo falta comparar fila por fila y no bastaba un umbral.
    expect(TOTAL_CARTERA / TOTAL_VENTAS).toBeLessThan(0.95);
  });
});
