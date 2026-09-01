import { describe, expect, test, beforeAll, afterAll, mock } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { Elysia } from 'elysia';
import { setupTestDatabase, ownerConnection, testOwnerUrl, testAppUrl } from './setup';
import { crearDobleDeCola } from './doble-de-cola';

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * "ESTA HOJA SÍ DEBERÍA CONTAR" Y "EL MONTO ESTÁ EN OTRA COLUMNA" (migración 0043)
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *
 * El portón (0042) le ENSEÑA al dueño las dos cosas que más caro cuestan de esta ingesta —una
 * hoja descartada por error y un dato leído de la columna equivocada— y hasta hoy no le daba
 * salida para ninguna: las veía y no podía hacer nada.
 *
 * Lo que este archivo protege son las cuatro formas de romperlo, y **ninguna hace ruido**:
 *
 *  1. **Que la corrección no se guarde donde el worker la lee.** El endpoint contesta 200, el
 *     cliente cree que arregló su archivo, y el reproceso descarta la hoja otra vez.
 *  2. **Que las filas viejas no se borren.** Corregir la columna del monto DUPLICA la hoja: las
 *     filas leídas mal siguen ahí y las nuevas se suman encima. El total sale al doble y cuadra
 *     con nada.
 *  3. **Que los lotes confirmados sobrevivan.** El worker es reanudable por lote a propósito
 *     (`document_ingest_batches` tiene índice único), así que si sus lotes quedan, la hoja
 *     corregida se SALTA entera y el cliente se queda sin ella — el fallo más caro, por la
 *     puerta que abrimos nosotros.
 *  4. **Que se pueda corregir una carga YA publicada.** Sus filas están en el ledger; reprocesar
 *     encima las cuenta dos veces.
 */

process.env.DATABASE_URL = testOwnerUrl;
process.env.APP_DATABASE_URL = testAppUrl;
process.env.WORKOS_JWKS_URL = 'https://example.invalid/jwks';

mock.module('@/lib/auth', () => ({
  verifyToken: async (token: string) => ({ sub: token }),
}));

const dobleDeCola = crearDobleDeCola();
const encolados = dobleDeCola.encolados;
mock.module('@/queue', () => dobleDeCola.modulo);

const { ingestion } = await import('@/modules/ingestion');

const app = new Elysia().use(ingestion);
const SUFIJO = randomUUID().slice(0, 8);
const WOS_USER = `wos_corregir_${SUFIJO}`;

function pedir(path: string, init?: RequestInit) {
  return app.handle(
    new Request(`http://localhost/documents${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${WOS_USER}`,
        'content-type': 'application/json',
        ...(init?.headers ?? {}),
      },
    }),
  );
}

const owner = ownerConnection();
let companyId: string;
let userId: string;

/** Una carga en el estado exacto en que la deja el worker antes de que el dueño confirme. */
async function crearCarga(nombre: string) {
  const [d] = await owner`
    insert into documents (company_id, uploaded_by, s3_key, original_filename,
                           file_size_bytes, mime_type, status, row_count, flagged_count)
    values (${companyId}, ${userId}, ${`${companyId}/${nombre}`}, ${nombre},
            100, 'text/csv', 'awaiting_confirmation', 2, 0)
    returning id`;
  const documentId = d!.id as string;

  for (const [i, hoja] of ['Ventas', 'Clientes'].entries()) {
    await owner`
      insert into staging_rows (company_id, document_id, target_entity, payload, confidence,
                                review_status, sheet_name)
      values (${companyId}, ${documentId}, 'transaction',
              ${owner.json({
                type: 'revenue',
                category: 'ventas',
                date: '2026-07-15',
                originalAmount: 100 + i,
                originalCurrency: 'GTQ',
                description: `fila de ${hoja}`,
              })},
              0.95, 'approved', ${hoja})`;
    await owner`
      insert into document_ingest_batches (company_id, document_id, sheet_name, batch_index,
                                           row_count)
      values (${companyId}, ${documentId}, ${hoja}, 0, 1)`;
  }
  return documentId;
}

const contar = async (
  documentId: string,
  hoja: string,
  tabla: 'staging_rows' | 'document_ingest_batches',
) =>
  Number(
    (
      await owner.unsafe(
        `select count(*)::int as n from ${tabla} where document_id = $1 and sheet_name = $2`,
        [documentId, hoja],
      )
    )[0]!.n,
  );

beforeAll(async () => {
  await setupTestDatabase();

  const [c] = await owner`
    insert into companies (workos_org_id, name, industry, base_currency)
    values (${`wos_org_corregir_${SUFIJO}`}, ${`Corregir ${SUFIJO}`}, 'retail', 'GTQ')
    returning id`;
  companyId = c!.id;

  const [u] = await owner`
    insert into users (workos_user_id, email)
    values (${WOS_USER}, ${`corregir-${SUFIJO}@test.local`}) returning id`;
  userId = u!.id;

  await owner`
    insert into company_users (company_id, user_id, role)
    values (${companyId}, ${userId}, 'owner')`;
});

afterAll(async () => {
  await owner?.end();
});

describe('POST /documents/:id/corregir-hoja', () => {
  test('rescatar una hoja la deja escrita donde el worker la lee, y re-encola', async () => {
    const doc = await crearCarga('rescate.xlsx');
    encolados.length = 0;

    const res = await pedir(`/${doc}/corregir-hoja`, {
      method: 'POST',
      body: JSON.stringify({ hoja: 'Clientes', forzar: true }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ reprocesando: true, hoja: 'Clientes' });

    const [fila] = await owner`
      select sheet_overrides as o, status from documents where id = ${doc}`;
    /*
     * La clave del objeto es el contrato con el worker: `forzar` es lo que `hojasForzadas` lee
     * antes del bucle de hojas. Un nombre distinto acá sería un 200 que no arregla nada.
     */
    expect(fila!.o).toEqual({ forzar: ['Clientes'], columnas: {} });
    // Vuelve a procesarse: el estado terminal lo fija el worker al terminar.
    expect(fila!.status).toBe('processing');

    expect(encolados.map((e) => e.queue)).toContain('excel.ingest');
  });

  test('borra las filas y los LOTES de esa hoja, y solo los de esa hoja', async () => {
    const doc = await crearCarga('columna.xlsx');

    await pedir(`/${doc}/corregir-hoja`, {
      method: 'POST',
      body: JSON.stringify({ hoja: 'Ventas', columnas: { amount: 6 } }),
    });

    /*
     * Las dos mitades del mismo arreglo, y hacen falta las dos: sin borrar las filas la hoja se
     * DUPLICA, y sin borrar los lotes la reanudación la SALTA y desaparece. Cada una tapa el
     * agujero de la otra si se afirman juntas, así que se cuentan por separado.
     */
    expect(await contar(doc, 'Ventas', 'staging_rows')).toBe(0);
    expect(await contar(doc, 'Ventas', 'document_ingest_batches')).toBe(0);
    // La otra hoja no se toca: corregir una no puede costar la contabilidad de las demás.
    expect(await contar(doc, 'Clientes', 'staging_rows')).toBe(1);
    expect(await contar(doc, 'Clientes', 'document_ingest_batches')).toBe(1);

    const [fila] = await owner`select sheet_overrides as o from documents where id = ${doc}`;
    expect(fila!.o).toEqual({ forzar: [], columnas: { Ventas: { amount: 6 } } });
  });

  test('dos correcciones se ACUMULAN en vez de pisarse', async () => {
    const doc = await crearCarga('acumula.xlsx');

    await pedir(`/${doc}/corregir-hoja`, {
      method: 'POST',
      body: JSON.stringify({ hoja: 'Clientes', forzar: true }),
    });
    await pedir(`/${doc}/corregir-hoja`, {
      method: 'POST',
      body: JSON.stringify({ hoja: 'Ventas', columnas: { amount: 4 } }),
    });

    const [fila] = await owner`select sheet_overrides as o from documents where id = ${doc}`;
    /*
     * El cliente corrige de a una hoja y aprieta publicar al final. Si la segunda pisara a la
     * primera, la hoja rescatada se volvería a descartar sin que nada lo dijera — y el síntoma
     * sería "a veces funciona", que es el más caro de diagnosticar.
     */
    expect(fila!.o).toEqual({ forzar: ['Clientes'], columnas: { Ventas: { amount: 4 } } });
  });

  test('una carga YA publicada no se corrige: reprocesar encima la duplicaría', async () => {
    const doc = await crearCarga('publicada.xlsx');
    await owner`update documents set confirmed_at = now(), status = 'promoted' where id = ${doc}`;
    encolados.length = 0;

    const res = await pedir(`/${doc}/corregir-hoja`, {
      method: 'POST',
      body: JSON.stringify({ hoja: 'Ventas', forzar: true }),
    });
    expect(res.status).toBe(409);
    // Y nada se tocó: ni las filas que ya están en el ledger, ni la cola.
    expect(await contar(doc, 'Ventas', 'staging_rows')).toBe(1);
    expect(encolados).toHaveLength(0);
  });

  test('el documento de otra empresa no existe para este cliente', async () => {
    const [otra] = await owner`
      insert into companies (workos_org_id, name, industry, base_currency)
      values (${`wos_org_ajena_${SUFIJO}`}, ${`Ajena ${SUFIJO}`}, 'retail', 'GTQ')
      returning id`;
    const [d] = await owner`
      insert into documents (company_id, uploaded_by, s3_key, original_filename,
                             file_size_bytes, mime_type, status)
      values (${otra!.id}, ${userId}, 'x/y.xlsx', 'y.xlsx', 10, 'text/csv',
              'awaiting_confirmation')
      returning id`;

    const res = await pedir(`/${d!.id}/corregir-hoja`, {
      method: 'POST',
      body: JSON.stringify({ hoja: 'Ventas', forzar: true }),
    });
    expect(res.status).toBe(404);
  });
});
