import { describe, expect, test, beforeAll, afterAll, mock } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { Elysia } from 'elysia';
import { setupTestDatabase, ownerConnection, testOwnerUrl, testAppUrl } from './setup';
import { crearDobleDeCola } from './doble-de-cola';

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════
 * CANCELAR UNA CARGA TIENE QUE BORRAR SU DINERO DEL DASHBOARD, NO SOLO DE LA TABLA
 * ═══════════════════════════════════════════════════════════════════════════════════════
 *
 * Reporte de Keneth (2026-08-31): el KPI de ingresos de agosto mostraba USD 18.460 y el
 * asesor, consultando `transactions`, contestaba USD 1.924. Dos cifras de la misma empresa,
 * del mismo mes, sacadas de la misma tabla, y ninguna capaz de desmentir a la otra.
 *
 * ═══ POR QUÉ ESTE FALLO NO HACE NINGÚN RUIDO ═══
 *
 * Las cifras del dashboard NO se leen de `transactions`: se leen de `metric_rollups`, que es un
 * CACHÉ (cache-aside, `getOrComputeMonthlyAmounts`). Un valor cacheado se devuelve tal cual sin
 * recalcularse, así que una cifra que quedó mal se queda mal — no hasta que alguien recargue la
 * página, sino hasta que algo escriba ese caché otra vez.
 *
 * `revert` refrescaba el caché desde el primer día. `cancel` no, y la asimetría no fue una
 * decisión: cuando se escribió, cancelar solo cambiaba el estado del documento y no había filas
 * que deshacer. Desde CU-868kttzb1 cancelar DESHACE lo que alcanzó a promoverse —la promoción
 * es parcial e incremental (migración 0020), así que una carga cancelada a mitad SÍ dejó filas
 * en producción— y el refresco se quedó del otro lado del cambio.
 *
 * ═══ QUÉ SE AFIRMA ACÁ, Y POR QUÉ ASÍ ═══
 *
 * Se mide la cifra que el cliente VE, o sea la que devuelve el camino de lectura del
 * dashboard, y no `transactions` directamente: consultar la tabla pasaría por alto el caché,
 * que es justamente donde vive el bug. Un test que leyera la tabla estaría verde con el código
 * roto.
 *
 * Y se ejercita la RUTA (`POST /documents/:id/cancel`) y no `cancelDocumentRows`, porque el
 * refresco vive en el handler a propósito: `cancelDocumentRows` corre también desde el worker,
 * dentro de la transacción del documento, y escribir ahí un caché de toda la empresa no
 * corresponde. Un test contra la función sola no distingue el arreglo de su ausencia.
 */

process.env.DATABASE_URL = testOwnerUrl;
process.env.APP_DATABASE_URL = testAppUrl;
process.env.WORKOS_JWKS_URL = 'https://example.invalid/jwks';

mock.module('@/lib/auth', () => ({
  verifyToken: async (token: string) => ({ sub: token }),
}));

const dobleDeCola = crearDobleDeCola();
mock.module('@/queue', () => dobleDeCola.modulo);

const { ingestion } = await import('@/modules/ingestion');
const { getOrComputeMonthlyAmounts } = await import('@/lib/rollups');
const { drizzle } = await import('drizzle-orm/postgres-js');
const schema = await import('@/db/schema');
import type { DB } from '@/db/client';

const app = new Elysia().use(ingestion);
const SUFIJO = randomUUID().slice(0, 8);
const WOS_USER = `wos_cancelar_${SUFIJO}`;
const PERIODO = '2026-08-01';

const owner = ownerConnection();
let db: DB;
let companyId: string;
let userId: string;

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

beforeAll(async () => {
  await setupTestDatabase();
  db = drizzle(owner, { schema }) as unknown as DB;

  const [c] = await owner`
    insert into companies (workos_org_id, name, industry, base_currency)
    values (${`wos_org_cancelar_${SUFIJO}`}, ${`Cancelar ${SUFIJO}`}, 'retail', 'USD')
    returning id
  `;
  companyId = c!.id;

  const sufijoTabla = companyId.replace(/-/g, '_');
  await owner.unsafe(
    `create table if not exists "transactions_${sufijoTabla}" partition of transactions
       for values in ('${companyId}')`,
  );

  const [u] = await owner`
    insert into users (workos_user_id, email)
    values (${WOS_USER}, ${`cancelar-${SUFIJO}@test.local`}) returning id
  `;
  userId = u!.id;

  await owner`
    insert into company_users (company_id, user_id, role)
    values (${companyId}, ${userId}, 'owner')
  `;
});

afterAll(async () => {
  await owner?.end();
});

/** Una carga EN CURSO que ya alcanzó a promover parte de sus filas. Es el estado real. */
async function cargaAMedias(monto: number): Promise<string> {
  const [d] = await owner`
    insert into documents (company_id, uploaded_by, s3_key, original_filename,
                           file_size_bytes, mime_type, status)
    values (${companyId}, ${userId}, ${`${companyId}/ventas-${randomUUID()}.xlsx`},
            'ventas.xlsx', 100, 'text/csv', 'processing')
    returning id
  `;
  const documentId = d!.id as string;

  /*
   * La fila de `transactions` se inserta directamente y no se promueve desde staging: lo que
   * se prueba es el DESHACER, y `deshacerFilas` no mira `staging_rows` — soft-borra
   * transactions/invoices/bills y sella el documento. Montar una promoción completa acá
   * mezclaría dos caminos en un mismo test rojo.
   */
  await owner`
    insert into transactions (company_id, document_id, date, type, category,
                              original_amount, original_currency, amount_base,
                              fx_rate, fx_rate_date)
    values (${companyId}, ${documentId}, ${PERIODO}, 'revenue', 'ventas',
            ${monto}, 'USD', ${monto}, 1, ${PERIODO})
  `;
  return documentId;
}

const ingresoQueVeElCliente = async (): Promise<number> =>
  (await getOrComputeMonthlyAmounts(db, companyId, [PERIODO])).get(PERIODO)!.revenue;

describe('POST /documents/:id/cancel', () => {
  test('el dinero de la carga cancelada desaparece de la cifra que ve el cliente', async () => {
    const buena = await cargaAMedias(1_924);
    const cancelada = await cargaAMedias(16_536);

    /*
     * El cliente MIRA el dashboard antes de cancelar. Este paso es el test: sin él, el caché
     * de agosto no existe todavía y la lectura posterior lo calcularía de cero contra la tabla
     * ya corregida — o sea que el test pasaría con el bug puesto. El fallo que se reproduce es
     * exactamente "la cifra ya estaba guardada".
     */
    expect(await ingresoQueVeElCliente()).toBe(18_460);

    const r = await pedir(`/${cancelada}/cancel`, { method: 'POST' });
    expect(r.status).toBe(200);

    // La tabla se corrigió: eso ya funcionaba antes y no es lo que se está probando.
    const [{ vivas }] = await owner`
      select count(*)::int as vivas from transactions
      where company_id = ${companyId} and document_id = ${cancelada} and deleted_at is null
    `;
    expect(vivas).toBe(0);

    /*
     * Y la cifra del dashboard también. Con el bug, acá salían 18.460 para siempre: los
     * USD 16.536 de una carga que el cliente canceló, sumados a su ingreso del mes, sin una
     * sola fila viva que los respaldara y sin nada que fallara.
     */
    expect(await ingresoQueVeElCliente()).toBe(1_924);
    expect(await ingresoQueVeElCliente()).toBe(1_924); // y se quedan corregidos en el caché

    void buena;
  });
});
