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

const FILAS_DEL_DOBLE = [
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
];

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
      store: null,
      dueDate: null,
      costTotal: null,
      costUnit: null,
    },
    unclassifiedRows: [],
    sheetUsable: true,
    unusableReason: null,
    rows: FILAS_DEL_DOBLE,
    veredictos: veredictosDe(FILAS_DEL_DOBLE),
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
const { cancelDocumentRows, revertDocument } = await import('@/lib/promotion');
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

/**
 * ═══ CANCELAR A MEDIAS Y RESUBIR (CU-868kttzb1) ═══
 *
 * El reporte de QA: *"el usuario al cargar de nuevo el file tiene que revertir el anterior
 * para que funcione bien, si no duplica números"*.
 *
 * Los dos .xlsx que mandó Keneth resultaron IDÉNTICOS byte a byte —mismo MD5— así que no era
 * un archivo distinto ni un mapa de columnas cambiado. Era el estado `cancelled` mintiendo:
 * la promoción es parcial e incremental (migración 0020), así que cancelar dejaba filas
 * VIVAS, pero `findSeenFingerprints` excluye `cancelled` de los estados con datos vivos —con
 * el argumento de que "ninguno deja filas vivas en producción"— así que sus huellas no
 * bloqueaban y resubir el mismo archivo las insertaba otra vez.
 *
 * El caso no estaba cubierto: los tests de arriba prueban cargar→revertir→recargar y el
 * archivo que CRECE, pero ninguno cancelaba a mitad de camino.
 */
describe('cancelar a medias y volver a subir el mismo archivo (CU-868kttzb1)', () => {
  /*
   * Punto de partida limpio. Los describes de arriba dejan una carga VIVA, y sus huellas sí
   * bloquean —correctamente— así que sin esto la primera subida de acá no ingeriría nada y el
   * test probaría otra cosa. Se deshace como lo haría `revert`: soft-delete + estado, que es
   * justo el camino que ya está probado más arriba.
   */
  beforeAll(async () => {
    await owner`update transactions set deleted_at = now() where company_id = ${companyId}`;
    await owner`update documents set status = 'reverted' where company_id = ${companyId}`;
    await refreshExistingRollups(drizzle(owner, { schema }) as never, companyId);
  });

  test('1) cancelar deshace las filas que alcanzaron a promoverse', async () => {
    const db = drizzle(owner, { schema }) as never;
    const doc = await subir('cancelada.xlsx');
    expect(await contarTx()).toBe(1);

    await cancelDocumentRows(db, companyId, doc);
    await refreshExistingRollups(db, companyId);

    expect(await estado(doc)).toBe('cancelled');
    // Lo que la persona cree que hizo al apretar "cancelar": sus cifras vuelven a como
    // estaban. Antes esta fila se quedaba viva y nadie la veía.
    expect(await contarTx()).toBe(0);
    expect(await dashboard()).toBe(0);
  });

  test('2) y resubir el MISMO archivo lo deja UNA sola vez, no dos', async () => {
    /*
     * EL BUG, en una línea. Antes acá salían 2 transacciones y el dashboard mostraba el
     * doble: la fila de la carga cancelada seguía viva y su huella ya no bloqueaba, así que
     * la segunda carga la insertaba de nuevo.
     *
     * Y explica el rodeo que descubrió QA —revertir antes de resubir—: revertir SÍ hacía
     * soft-delete, así que por ese camino no se duplicaba.
     */
    const doc = await subir('cancelada.xlsx');

    expect(await estado(doc)).toBe('promoted');
    expect(await contarTx()).toBe(1);
    expect(await dashboard()).toBe(MONTO);
  });
});
