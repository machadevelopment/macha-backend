import { describe, expect, test, beforeAll, afterAll, mock } from 'bun:test';
import * as XLSX from 'xlsx';
import { setupTestDatabase, ownerConnection, testOwnerUrl, testAppUrl } from './setup';
import { crearDobleDeCola } from './doble-de-cola';

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════
 * LA HOJA GRANDE Y UNIFORME QUE DEJA DE PAGARSE
 * ═══════════════════════════════════════════════════════════════════════════════════════
 *
 * El recibo que motivó el cortocircuito (`lib/sheet-consensus.ts`):
 * `CasaViva_Registro_Operaciones_2025-2026.xlsx` de House Products, 2026-08-18, USD 15,82 y
 * 14 minutos en 216 llamadas — de las cuales **205 fueron una sola hoja** (`Ventas`, 18.034
 * filas) devolviendo `transaction/revenue` en todas, sin una excepción.
 *
 * ═══ POR QUÉ NO ALCANZAN LOS TESTS UNITARIOS ═══
 *
 * `sheet-consensus.test.ts` prueba la DECISIÓN con datos reales, y es donde viven los umbrales.
 * Pero la decisión correcta no sirve de nada si el worker la aplica mal, y las tres cosas que
 * pueden salir mal solo se ven de punta a punta:
 *
 *   · que de verdad se dejen de hacer las llamadas (si no, el ahorro es cero y nada falla);
 *   · que las filas cortocircuitadas lleguen COMPLETAS a la contabilidad del cliente
 *     (perderlas no rompe nada: simplemente no aparecen, y nadie se entera);
 *   · que un renglón que NO es un movimiento no se cuele como ingreso.
 *
 * Corre el worker real contra Postgres real. Solo se finge lo que sale de la máquina — S3,
 * Claude y la cola.
 */

process.env.DATABASE_URL = testOwnerUrl;
process.env.APP_DATABASE_URL = testAppUrl;

const HOJA = 'Ventas';
const MES = '2026-07-01';

/**
 * 400 ventas: suficientes para varios lotes con el tamaño real
 * (`outputTokenBudget` 6.300 / 70 por fila = 90 filas por llamada), que es la única forma de
 * que haya lotes FUERA de la sonda. Con una hoja que cabe en tres lotes no habría nada que
 * cortocircuitar y el test pasaría sin probar nada.
 */
const VENTAS: [fecha: string, monto: number][] = Array.from({ length: 400 }, (_, i) => [
  `2026-07-${String((i % 28) + 1).padStart(2, '0')}`,
  100 + i,
]);
const TOTAL_VENTAS = VENTAS.reduce((s, [, m]) => s + m, 0);

/**
 * Un SUBTOTAL metido a media hoja, que es como los escribe una persona en Excel: trae monto y
 * no trae fecha.
 *
 * La posición no es decorativa. La sonda toma tres lotes REPARTIDOS (primero, medio, último —
 * ver `elegirSonda`), así que con cinco lotes mira el 0, el 2 y el 4. El índice de acá cae en
 * el lote 1, uno de los que el modelo NUNCA ve: es el único sitio donde se puede comprobar que
 * el candado por fila del cortocircuito hace su trabajo por sí solo.
 */
const INDICE_SUBTOTAL = 120;
const MONTO_SUBTOTAL = 999_999;

function libro(): Buffer {
  const filas: unknown[][] = [['fecha', 'monto'], ...VENTAS];
  filas.splice(INDICE_SUBTOTAL + 1, 0, ['SUBTOTAL JULIO', MONTO_SUBTOTAL]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(filas), HOJA);
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}

/** Cuántas veces se llamó al modelo. Es la medida del ahorro. */
let llamadasAlModelo = 0;
/** Los tamaños de cada lote que SÍ llegó al modelo, para reconstruir el plan de lotes. */
const filasPorLlamada: number[] = [];

const anthropicReal = await import('@/lib/anthropic');

const MAPA = {
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
};

/**
 * El doble del modelo: clasifica TODA fila con monto numérico como la misma venta, que es lo
 * que hizo el modelo de verdad sobre la hoja real.
 *
 * Las filas sin monto numérico —el encabezado, el subtotal— vuelven como `skip`, que es el
 * veredicto explícito que el esquema exige para "esto no es un dato". Así el doble se comporta
 * como el modelo real y la tasa de `skip` que mide el consenso es la de verdad.
 */
mock.module('@/lib/anthropic', () => ({
  ...anthropicReal,
  classifySheetRows: async (params: { rows: unknown[][] }) => {
    llamadasAlModelo++;
    filasPorLlamada.push(params.rows.length);

    const veredictos = params.rows.map((row) =>
      typeof row[1] === 'number' && typeof row[0] === 'string' && row[0].startsWith('2026')
        ? { e: 'transaction', t: 'revenue' as const, c: 'ventas', cf: 0.95 }
        : { e: 'skip', t: null, c: null, cf: 0 },
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
      rows: params.rows
        .map((row, i) => ({ row, v: veredictos[i]! }))
        .filter(({ v }) => v.e !== 'skip')
        .map(({ row }) => ({
          targetEntity: 'transaction' as const,
          payload: {
            type: 'revenue',
            category: 'ventas',
            date: String(row[0]),
            originalAmount: Number(row[1]),
            originalCurrency: 'GTQ',
          },
          confidence: 0.95,
        })),
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
  downloadObject: async () => libro(),
}));

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
const { getOrComputeMonthlyAmounts } = await import('@/lib/rollups');
const { SONDA_LOTES } = await import('@/lib/sheet-consensus');
const { drizzle } = await import('drizzle-orm/postgres-js');
const schema = await import('@/db/schema');

const owner = ownerConnection();
let companyId: string;
let userId: string;
let documentId: string;

beforeAll(async () => {
  await setupTestDatabase();

  const [c] = await owner`
    insert into companies (workos_org_id, name, industry, base_currency)
    values ('wos_cortocircuito', 'Cortocircuito SA', 'retail', 'GTQ') returning id
  `;
  companyId = c!.id;
  await owner.unsafe(
    `create table if not exists "transactions_${companyId.replace(/-/g, '_')}"
       partition of transactions for values in ('${companyId}')`,
  );

  const [u] = await owner`
    insert into users (workos_user_id, email)
    values ('wos_cortocircuito_u', 'cortocircuito@test.local') returning id
  `;
  userId = u!.id;

  await startExcelIngestWorker();

  const [d] = await owner`
    insert into documents (company_id, uploaded_by, s3_key, original_filename,
                           file_size_bytes, mime_type, status)
    values (${companyId}, ${userId}, ${`${companyId}/ventas.xlsx`}, 'ventas.xlsx',
            100, 'text/csv', 'queued')
    returning id
  `;
  documentId = d!.id;
  await handler!({ documentId, companyId });
});

afterAll(async () => {
  await owner?.end();
});

const unNumero = async (q: Promise<{ n: number }[]>): Promise<number> => (await q)[0]!.n;

describe('hoja grande y uniforme: se cortocircuita', () => {
  test('1) el plan tuvo más lotes que la sonda (si no, no se prueba nada)', () => {
    /*
     * Guardia del propio test. Si un cambio de `outputTokenBudget` hiciera que las 401 filas
     * cupieran en tres lotes, todo lo de abajo pasaría sin ejercer el cortocircuito — y este
     * archivo diría que el ahorro funciona cuando en realidad nunca ocurrió.
     */
    const lotesTotales = Math.ceil(
      (VENTAS.length + 2) / Math.max(...filasPorLlamada, 1), // +2: encabezado y subtotal
    );
    expect(lotesTotales).toBeGreaterThan(SONDA_LOTES);
  });

  test('2) al modelo se le llamó SOLO para la sonda', async () => {
    expect(llamadasAlModelo).toBe(SONDA_LOTES);

    // Y la contabilidad de llamadas queda registrada igual: una fila de `ai_usage_events` por
    // llamada REAL, ninguna por lote resuelto en código. Es lo que hace visible el ahorro en
    // el panel de costos en vez de esconderlo.
    expect(
      await unNumero(
        owner`select count(*)::int as n from ai_usage_events
              where ref_id = ${documentId} and kind = 'excel'`,
      ),
    ).toBe(SONDA_LOTES);
  });

  test('3) TODOS los lotes quedaron marcados, no solo los de la sonda', async () => {
    /*
     * La reanudación por lote (CU-868kkgypv) lee `document_ingest_batches`. Si el lote local no
     * se marcara, un reintento lo volvería a procesar y duplicaría sus filas.
     */
    const marcados = await unNumero(
      owner`select count(*)::int as n from document_ingest_batches where document_id = ${documentId}`,
    );
    expect(marcados).toBeGreaterThan(SONDA_LOTES);
  });

  test('4) no se perdió ni una venta: las 400 están en la contabilidad', async () => {
    /*
     * La aserción que de verdad importa. Una fila perdida por el cortocircuito no rompe nada:
     * simplemente no aparece en el dashboard del cliente, y nadie se entera nunca.
     */
    expect(
      await unNumero(
        owner`select count(*)::int as n from transactions
              where company_id = ${companyId} and deleted_at is null`,
      ),
    ).toBe(VENTAS.length);
  });

  test('5) y el ingreso del mes es el del archivo, al centavo', async () => {
    const db = drizzle(owner, { schema }) as never;
    const m = await getOrComputeMonthlyAmounts(db, companyId, [MES]);
    expect(m.get(MES)!.revenue).toBe(TOTAL_VENTAS);
  });

  test('6) el SUBTOTAL de un lote que el modelo no vio NO se contó como ingreso', async () => {
    /*
     * ═══ EL CANDADO POR FILA, PROBADO DONDE IMPORTA ═══
     *
     * Este renglón cayó en un lote fuera de la sonda, así que ningún modelo lo miró: lo único
     * que lo separó de entrar como una venta de Q 999.999 fue `filaAptaParaCortocircuito`, que
     * exige fecha Y monto legibles.
     *
     * Es el modo de fallo caro del cortocircuito: un total sumado como movimiento infla el
     * ingreso del cliente con un dato plausible y sin un solo error en el log.
     */
    const [fila] = await owner`
      select count(*)::int as n from transactions
      where company_id = ${companyId} and deleted_at is null
        and original_amount = ${MONTO_SUBTOTAL}
    `;
    expect(fila!.n).toBe(0);
  });

  test('7) el subtotal no se descartó: está en revisión interna', async () => {
    /*
     * La otra mitad de la regla que el proyecto no negocia: ninguna fila desaparece en
     * silencio. La que el cortocircuito no se atrevió a clasificar va a revisión con confianza
     * 0, igual que la fila que el modelo no logró cubrir.
     */
    const marcadas = await owner`
      select flag_reason, review_status from staging_rows
      where document_id = ${documentId} and flag_reason is not null
    `;
    expect(marcadas.length).toBe(1);
    expect(marcadas[0]!.review_status).toBe('pending');
  });

  test('8) el documento quedó promovido, no atascado en revisión', async () => {
    // La promoción es PARCIAL (migración 0020): las limpias entran solas y solo la marcada
    // espera. Un `promoted` con `flagged_count > 0` es el estado normal.
    const [d] = await owner`
      select status, flagged_count from documents where id = ${documentId}
    `;
    expect(d!.status).toBe('promoted');
    expect(d!.flagged_count).toBe(1);
  });

  /*
   * ═══════════════════════════════════════════════════════════════════════════════════════════
   * 9-10) EL DIAGNÓSTICO QUEDA ESCRITO, NO EN UN LOG QUE ROTA
   * ═══════════════════════════════════════════════════════════════════════════════════════════
   *
   * `lib/cuadre.ts` es lo único del pipeline capaz de detectar un fallo sobre un archivo que
   * nadie vio nunca — los tests cubren archivos que ya vimos, y ahí estuvo el hueco durante
   * siete reportes de clientes. Su veredicto iba a `console.warn` y a ningún otro lado, pese a
   * que su propio encabezado afirmaba que "queda ESCRITO en el resumen de la carga".
   *
   * Verificado el 2026-08-31 contra producción: buscando el veredicto de dos cargas que un
   * cliente acababa de reportar, ya no existía. Railway conserva una ventana corta, no agrega
   * y no alerta.
   *
   * Se afirma sobre el worker REAL y no sobre la función, porque lo que falla no es el cálculo
   * —eso ya tiene sus tests unitarios— sino que nadie lo guarde.
   */
  test('9) el veredicto del cuadre queda guardado en el documento', async () => {
    const [d] = await owner`select reconciliation from documents where id = ${documentId}`;
    const r = d!.reconciliation as {
      verificadoEl: string;
      cuadra: boolean;
      documento: unknown[];
      hojas: { hoja: string; cuadres: { veredicto: string }[] }[];
    } | null;

    expect(r).not.toBeNull();
    expect(r!.documento.length).toBeGreaterThan(0);
    // Y por HOJA, que es lo que el total del documento no puede ver: dos errores de signo
    // opuesto en dos hojas distintas se cancelan y la carga parece perfecta.
    expect(r!.hojas.map((h) => h.hoja)).toContain(HOJA);
    /*
     * `en_revision` y no `cuadra`, y es lo correcto: esta corrida deja a propósito una fila de
     * Q 999.999 esperando revisión. Es un veredicto PROPIO justamente para esto — el dinero
     * está identificado y con dueño, no perdido —, y confundirlo con `falta` haría que el caso
     * caro se pierda entre decenas del rutinario.
     */
    expect(r!.hojas[0]!.cuadres[0]!.veredicto).toBe('en_revision');
    // Y el documento no se marca como descuadrado por eso: una fila en revisión es normal.
    expect(r!.cuadra).toBe(true);
  });

  test('10) cada fila de staging sabe de qué hoja salió', async () => {
    // Migración 0039. Sin esto el cuadre por hoja no existe, y además la cola de revisión
    // interna le muestra al operador una fila suelta sin decirle de dónde vino.
    const [f] = await owner`
      select count(*)::int as total,
             count(*) filter (where sheet_name = ${HOJA})::int as con_hoja
      from staging_rows where document_id = ${documentId}
    `;
    expect(f!.total).toBeGreaterThan(0);
    expect(f!.con_hoja).toBe(f!.total);
  });
});
