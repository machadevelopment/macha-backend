import { describe, expect, test, beforeAll, afterAll, mock } from 'bun:test';
import { randomUUID } from 'node:crypto';
import * as XLSX from 'xlsx';
import { setupTestDatabase, ownerConnection, testOwnerUrl, testAppUrl } from './setup';
import { crearDobleDeCola } from './doble-de-cola';
import * as anthropicReal from '@/lib/anthropic';

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * EL FLUJO COMPLETO: SUBIR UN ARCHIVO → RECIBIR EL CORREO → LLEGAR AL DOCUMENTO
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *
 * `aviso-conceptos-pendientes.test.ts` prueba las reglas del aviso llamando a la función con
 * filas ya sembradas. Esto corre el WORKER de verdad sobre un Excel de verdad, que es lo único
 * que puede afirmar las dos cosas que el ticket promete de punta a punta:
 *
 *   1. que una carga con conceptos sin clasificar **dispare el correo sola**, sin que nadie
 *      llame a nada — o sea que el disparador esté conectado al worker y no solo escrito;
 *   2. que el enlace del correo apunte al documento que el cliente acaba de subir.
 *
 * ⚠️ Y cubre el caso que el TICKET SE PERDÍA. El ticket pide disparar "en el mismo punto donde
 * se escribe `status: 'review'`". Con promoción parcial (migración 0020) una carga con filas
 * retenidas termina en **`promoted` con `flagged_count > 0`** —el estado normal— y solo llega a
 * `review` la que no pudo promover nada. Este archivo produce exactamente ese caso normal: si
 * el aviso estuviera donde el ticket decía, no llegaría ningún correo.
 */

process.env.DATABASE_URL = testOwnerUrl;
process.env.APP_DATABASE_URL = testAppUrl;

/** Mapa de columnas del Excel de abajo: `Fecha · Concepto · Monto`. */
const MAPA = {
  date: 0,
  amount: 2,
  currency: null,
  description: 1,
  counterparty: null,
  product: null,
  quantity: null,
  productCategory: null,
  store: null,
  dueDate: null,
  costTotal: null,
  costUnit: null,
};

/*
 * EL MODELO DOBLE. Clasifica las ventas con confianza alta y deja los DOS conceptos raros con
 * confianza baja: ahí está el caso del ticket — filas que solo el cliente puede clasificar,
 * conviviendo con contabilidad que entra limpia.
 */
mock.module('@/lib/anthropic', () => ({
  ...anthropicReal,
  classifySheetRows: async (params: { rows: unknown[][] }) => {
    const veredictos = params.rows.map((row) => {
      /*
       * `skip` para lo que no es un movimiento — igual que haría el modelo real. Sin esta
       * guarda el doble clasifica también la fila de ENCABEZADO y aparece un tercer
       * "concepto" llamado *Concepto*: el correo prometía 3 preguntas y la pantalla mostraba
       * 2. Un doble más tonto que el modelo le achaca al producto un fallo que no es suyo.
       */
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(row[0] ?? ''))) {
        return { e: 'skip' as const, t: null, c: null, cf: 0 };
      }
      const concepto = String(row[1] ?? '');
      if (concepto.startsWith('Venta')) {
        return { e: 'transaction' as const, t: 'revenue' as const, c: 'ventas', cf: 0.95 };
      }
      // Sin categoría y con poca confianza: es lo que produce un concepto pendiente.
      return { e: 'transaction' as const, t: 'opex' as const, c: null, cf: 0.3 };
    });
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
      /*
       * `rows` son filas YA ARMADAS (`ClassifiedRow`), no la fila cruda con su veredicto:
       * es lo que `insertStagingRows` inserta tal cual. Devolver la forma equivocada revienta
       * dentro de `staging-rules`, lejos de acá y sin mencionar este archivo.
       */
      rows: params.rows
        .map((row, i) => ({ row, v: veredictos[i]! }))
        .filter(({ v }) => v.e !== 'skip')
        .map(({ row, v }) => {
          return {
            targetEntity: 'transaction' as const,
            confidence: v.cf,
            payload: {
              type: v.t,
              category: v.c,
              date: String(row[0]),
              description: String(row[1]),
              originalAmount: Number(row[2]),
              originalCurrency: 'GTQ',
            },
          };
        }),
    };
  },
  estimateCostUsd: () => 0.001,
  DEFAULT_INSIGHT_PROMPT: '',
}));

/**
 * El archivo nunca sale de S3 en un test: se sirve el binario que se armó acá.
 *
 * ⚠️ CON EL SPREAD DEL MÓDULO REAL, y no es opcional. `mock.module` es GLOBAL al proceso y la
 * suite corre en una sola invocación, así que este doble reemplaza `@/lib/s3` para TODOS los
 * archivos. Sin el spread no "agrega" `downloadObject`: BORRA los otros nueve exports, y
 * cualquier archivo que importe `uploadKey` revienta con un error que no menciona ni este
 * archivo ni este mock.
 *
 * Me pasó exactamente eso al escribir esto —`UNDEFINED_VALUE` desde `tenant.derive`, en un
 * archivo distinto— y la nota que lo explica ya estaba escrita en `cortocircuito-hoja-e2e`.
 */
let binario: Buffer;
const s3Real = await import('@/lib/s3');
mock.module('@/lib/s3', () => ({
  ...s3Real,
  downloadObject: async () => binario,
}));

const dobleDeCola = crearDobleDeCola();
mock.module('@/queue', () => dobleDeCola.modulo);

const { startExcelIngestWorker } = await import('@/queue/workers/excel-ingest');

const owner = ownerConnection();
const SUFIJO = randomUUID().slice(0, 8);
let companyId: string;
let userId: string;
let documentId: string;

/** El handler que `startExcelIngestWorker` registra en la cola; el doble lo guarda por nombre. */
const correrWorker = async (payload: { documentId: string; companyId: string }) => {
  const handler = dobleDeCola.handlers.get('excel.ingest');
  if (!handler) throw new Error('el worker de ingesta no se registró en el doble de la cola');
  // `registerWorker` desenvuelve el job de pg-boss y le pasa al handler el PAYLOAD PLANO
  // (`job.data`), así que acá se le entrega igual. Envolverlo en `{ data }` deja
  // `companyId` en undefined y el fallo aparece en otro módulo, sin mencionar a este.
  await handler(payload as never);
};

beforeAll(async () => {
  await setupTestDatabase();

  const [c] = await owner`
    insert into companies (workos_org_id, name, industry, base_currency, locale)
    values (${`org_e2e_aviso_${SUFIJO}`}, ${`E2E Aviso ${SUFIJO}`}, 'retail', 'GTQ', 'es')
    returning id`;
  companyId = c!.id;
  await owner.unsafe(
    `create table if not exists "transactions_${companyId.replace(/-/g, '_')}"
       partition of transactions for values in ('${companyId}')`,
  );

  const [u] = await owner`
    insert into users (workos_user_id, email)
    values (${`wos_e2e_aviso_${SUFIJO}`}, ${`duena-e2e-${SUFIJO}@test.local`}) returning id`;
  userId = u!.id;
  await owner`
    insert into company_users (company_id, user_id, role, status, receives_reports)
    values (${companyId}, ${userId}, 'owner', 'active', true)`;

  /*
   * El libro: 30 ventas limpias que se promueven solas + 4 filas de DOS conceptos raros que el
   * cliente tiene que clasificar. Es la forma de un archivo real, y la que produce el estado
   * `promoted` con filas retenidas.
   */
  const filas: unknown[][] = [['Fecha', 'Concepto', 'Monto']];
  for (let i = 1; i <= 30; i++) {
    filas.push([`2026-07-${String((i % 28) + 1).padStart(2, '0')}`, `Venta ${i}`, 100 + i]);
  }
  for (let i = 0; i < 2; i++) {
    filas.push([`2026-07-1${i}`, 'Flete Cropa', 1200 + i]);
    filas.push([`2026-07-2${i}`, 'Pago Vecinos SA', 800 + i]);
  }
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(filas), 'Movimientos');
  binario = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;

  const [d] = await owner`
    insert into documents (company_id, uploaded_by, s3_key, original_filename,
                           file_size_bytes, mime_type, status)
    values (${companyId}, ${userId}, ${`${companyId}/ventas.xlsx`}, 'Ventas_Agosto.xlsx',
            1000, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'queued')
    returning id`;
  documentId = d!.id;

  await startExcelIngestWorker();
  await correrWorker({ documentId, companyId });
});

afterAll(async () => {
  await owner?.end();
});

const correos = () => dobleDeCola.encolados.filter((e) => e.queue === 'email.send');

describe('de un Excel real al correo, sin que nadie llame a nada', () => {
  test('1) la carga queda PROMOTED con filas retenidas — el caso normal', async () => {
    const [doc] = await owner`
      select status, row_count, flagged_count from documents where id = ${documentId}`;
    /*
     * Si esto dijera `review`, el archivo no habría podido promover NADA y el caso del ticket
     * seguiría sin cubrirse. `promoted` + `flagged_count > 0` es el estado que la promoción
     * parcial produce y el que el disparador tiene que reconocer.
     */
    expect(doc!.status).toBe('promoted');
    expect(Number(doc!.flagged_count)).toBeGreaterThan(0);
  });

  test('2) las ventas limpias YA están en el dashboard', async () => {
    // Es la mitad que el correo afirma en su pie ("el resto de tus datos ya está en tu
    // dashboard"). Si esto fuera 0, ese texto sería mentira.
    const [t] = await owner`
      select count(*)::int as n from transactions
      where company_id = ${companyId} and deleted_at is null and type = 'revenue'`;
    expect(t!.n).toBe(30);
  });

  test('3) el worker mandó UN correo, solo, con el conteo de CONCEPTOS', () => {
    expect(correos()).toHaveLength(1);

    const c = correos()[0]!.payload as Record<string, unknown>;
    expect(c.kind).toBe('review_needed');
    expect(c.refId).toBe(documentId);
    expect(c.subject).toContain('Ventas_Agosto.xlsx');

    /*
     * DOS conceptos, no CUATRO filas. Es la diferencia que hace creíble al aviso: el cliente
     * abre la pantalla y encuentra exactamente las dos preguntas que el correo prometió.
     */
    expect(String(c.html)).toContain('2 conceptos');
  });

  test('4) el CTA lleva al documento exacto, no a la sección', () => {
    const c = correos()[0]!.payload as Record<string, unknown>;
    expect(String(c.html)).toContain(`/upload?doc=${documentId}`);
  });

  test('5) el correo quedó registrado en `notifications` — esa fila ES la idempotencia', async () => {
    const filas = await owner`
      select kind, ref_id from notifications
      where company_id = ${companyId} and kind = 'review_needed'`;
    expect(filas).toHaveLength(1);
    expect(filas[0]!.ref_id).toBe(documentId);
  });

  test('6) reprocesar la MISMA carga no manda un segundo correo', async () => {
    /*
     * pg-boss reintenta hasta 3 veces y el worker es reanudable, así que este camino se recorre
     * de verdad en producción. Un correo por reintento sería un cliente recibiendo tres avisos
     * de la misma carga.
     */
    const antes = correos().length;
    await correrWorker({ documentId, companyId });
    expect(correos().length).toBe(antes);
  });
});
