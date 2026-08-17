import { describe, expect, test, beforeAll, afterAll, mock } from 'bun:test';
import * as XLSX from 'xlsx';
import { setupTestDatabase, ownerConnection, testOwnerUrl, testAppUrl } from './setup';

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════
 * EL CICLO COMPLETO CON EL WORKER DE VERDAD
 * ═══════════════════════════════════════════════════════════════════════════════════════
 *
 * Reporte de Jose (2026-08-14): *"cuando se borra un archivo y luego se carga otro, aparece
 * como done pero no se actualiza la data"*.
 *
 * Los otros tests fijan cada pieza por separado —la huella, el rollup, el estado—. Este corre
 * **el worker real de principio a fin**, dos veces, con una reversión en medio. Es el único
 * que demuestra que las piezas juntas producen lo que el cliente ve, y es lo que faltaba: el
 * bug vivía justo en la costura entre la deduplicación y la reversión, no dentro de ninguna
 * de las dos.
 *
 * Solo se finge lo que sale de la máquina —S3, Claude, la cola—. La base es real, se cuentan
 * filas de producción y se leen los rollups por el mismo camino que el dashboard.
 *
 * ANTES DEL ARREGLO este test fallaba en el paso 5: la segunda carga filtraba todas sus filas
 * como "ya ingeridas" —las huellas del documento revertido seguían contando—, el documento
 * terminaba en `promoted` con cero transacciones y el dashboard se quedaba en cero. Exactamente
 * el síntoma reportado.
 */

process.env.DATABASE_URL = testOwnerUrl;
process.env.APP_DATABASE_URL = testAppUrl;

const HOJA = 'Ventas';
const FECHA = '2023-04-10';
const MES = '2023-04-01';
const MONTO = 750;

function libro(): Buffer {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.aoa_to_sheet([
      ['fecha', 'monto'],
      [FECHA, MONTO],
    ]),
    HOJA,
  );
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}

const anthropicReal = await import('@/lib/anthropic');

mock.module('@/lib/anthropic', () => ({
  ...anthropicReal,
  classifySheetRows: async () => ({
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
      dueDate: null,
      costTotal: null,
      costUnit: null,
    },
    unclassifiedRows: [],
    sheetUsable: true,
    unusableReason: null,
    rows: [
      {
        targetEntity: 'transaction' as const,
        payload: {
          type: 'revenue',
          category: 'ventas',
          date: FECHA,
          originalAmount: MONTO,
          originalCurrency: 'GTQ',
        },
        confidence: 0.95,
      },
    ],
  }),
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
const { revertDocument } = await import('@/lib/promotion');
const { getOrComputeMonthlyAmounts, refreshExistingRollups } = await import('@/lib/rollups');
const { drizzle } = await import('drizzle-orm/postgres-js');
const schema = await import('@/db/schema');

const owner = ownerConnection();
let companyId: string;
let userId: string;

beforeAll(async () => {
  await setupTestDatabase();

  const [c] = await owner`
    insert into companies (workos_org_id, name, industry, base_currency)
    values ('wos_e2e_revert', 'Ciclo E2E SA', 'retail', 'GTQ') returning id
  `;
  companyId = c!.id;

  await owner.unsafe(
    `create table if not exists "transactions_${companyId.replace(/-/g, '_')}"
       partition of transactions for values in ('${companyId}')`,
  );

  const [u] = await owner`
    insert into users (workos_user_id, email)
    values ('wos_e2e_revert_u', 'e2e_revert@test.local') returning id
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

const contarTx = async (): Promise<number> => {
  const [r] = await owner`
    select count(*)::int as n from transactions
    where company_id = ${companyId} and deleted_at is null
  `;
  return r!.n;
};

const estado = async (documentId: string): Promise<string> => {
  const [r] = await owner`select status from documents where id = ${documentId}`;
  return r!.status;
};

const dashboard = async (): Promise<number> => {
  const db = drizzle(owner, { schema }) as never;
  const m = await getOrComputeMonthlyAmounts(db, companyId, [MES]);
  return m.get(MES)!.revenue;
};

describe('cargar → revertir → volver a cargar, con el worker real', () => {
  let doc1: string;

  test('1) la primera carga entra y el dashboard la muestra', async () => {
    doc1 = await subir('ventas.xlsx');

    expect(await estado(doc1)).toBe('promoted');
    expect(await contarTx()).toBe(1);
    expect(await dashboard()).toBe(MONTO);
  });

  test('2) al revertir, las cifras caen a cero', async () => {
    const db = drizzle(owner, { schema }) as never;
    await revertDocument(db, companyId, doc1);
    await refreshExistingRollups(db, companyId);

    expect(await estado(doc1)).toBe('reverted');
    expect(await contarTx()).toBe(0);
    // Antes del arreglo del índice, una fila duplicada del rollup podía sobrevivir acá y
    // seguir mostrando 750 en el dashboard con la contabilidad ya en cero.
    expect(await dashboard()).toBe(0);
  });

  test('3) volver a subir el MISMO archivo recupera los datos', async () => {
    /*
     * ESTE es el test que fallaba. Las huellas registradas por `doc1` seguían contando
     * aunque `doc1` estuviera revertido, así que el worker filtraba la única fila del
     * archivo, no llamaba al modelo, y el documento terminaba `promoted` con cero
     * transacciones y el mensaje "ya teníamos todo".
     *
     * Para el cliente: "aparece como done pero no se actualiza la data". Y era permanente —
     * mientras la huella existiera, ese archivo no se podía volver a cargar nunca.
     */
    const doc2 = await subir('ventas.xlsx');

    expect(await estado(doc2)).toBe('promoted');
    expect(await contarTx()).toBe(1);
    expect(await dashboard()).toBe(MONTO);
  });

  test('4) y la deduplicación SIGUE funcionando con documentos vivos', async () => {
    /*
     * El contraste que impide que el arreglo se convierta en otro bug: si ahora dejara pasar
     * todo, el cliente que resube su contabilidad cada semana pagaría de nuevo el archivo
     * entero. La carga de `doc2` sigue viva, así que esta tercera no debe aportar nada.
     */
    const doc3 = await subir('ventas.xlsx');

    expect(await contarTx()).toBe(1);
    expect(await dashboard()).toBe(MONTO);

    // Y el documento lo DICE, en vez de fingir que procesó algo.
    const [r] =
      await owner`select status, row_count, error_reason from documents where id = ${doc3}`;
    expect(r!.status).toBe('promoted');
    expect(r!.row_count).toBe(0);
    expect(String(r!.error_reason ?? '')).toMatch(/ya ten|already had/i);
  });
});
