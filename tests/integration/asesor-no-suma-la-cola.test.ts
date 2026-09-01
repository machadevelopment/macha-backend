import { describe, expect, test, beforeAll, afterAll } from 'bun:test';
import { drizzle } from 'drizzle-orm/postgres-js';
import { ownerConnection, setupTestDatabase } from './setup';
import * as schema from '@/db/schema';
import { executeChatTool, type ChatToolContext } from '@/lib/chat-tools';
import type { DB } from '@/db/client';

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════
 * `query_transactions` NO DEVUELVE "LAS TRANSACCIONES DEL PERÍODO"
 * ═══════════════════════════════════════════════════════════════════════════════════════
 *
 * Reporte de Keneth (2026-08-31): el KPI de agosto decía USD 18.460 y el asesor, preguntado
 * por el desglose del mes, contestó **USD 1.924 en 14 transacciones** y explicó la diferencia
 * él mismo: *"much lower than the $18,460 I quoted earlier, since that figure likely included
 * data past the 24th that isn't in the transaction log yet, or a rollup discrepancy"*.
 *
 * No hubo discrepancia de rollup. La herramienta devolvía un array pelado de como mucho 50
 * filas ordenadas por fecha DESCENDENTE, así que el asesor sumó la COLA de la tabla y presentó
 * el resultado como el total del mes. Un array pelado no tiene forma de decir "hay 300 más": es
 * sintácticamente idéntico a la respuesta completa, y el modelo no puede distinguirlos. Cuando
 * el número no cuadró con el KPI, hizo lo que hace un modelo con dos datos que no encajan —
 * inventó una causa, y la causa señalaba a una falla del sistema que no existía.
 *
 * El segundo defecto es del mismo tamaño y estaba al lado: era el ÚNICO consumidor de
 * `transactions` del backend que no filtraba `deleted_at`. `rollups.ts`, `report-sections.ts`,
 * `alerts.ts`, `metrics/*` y `transactions/index.ts` lo filtran todos. O sea que el asesor
 * contaba las filas de una carga REVERTIDA mientras el dashboard, correctamente, ya no.
 *
 * Los dos se prueban contra Postgres real porque los dos viven en el `where` de una consulta,
 * no en lógica de JavaScript.
 */

const PERIODO = '2019-07';

describe('query_transactions: lo que se recorta se declara', () => {
  let owner: ReturnType<typeof ownerConnection>;
  let db: DB;
  let ctx: ChatToolContext;
  let companyId: string;
  let documentId: string;

  beforeAll(async () => {
    await setupTestDatabase();
    owner = ownerConnection();
    db = drizzle(owner, { schema }) as unknown as DB;

    const [c] = await owner`
      insert into companies (workos_org_id, name, industry, base_currency)
      values ('org_asesor_cola', 'Asesor Cola SA', 'retail', 'USD') returning id
    `;
    companyId = c!.id;
    ctx = { db, companyId };

    const sufijo = companyId.replace(/-/g, '_');
    await owner.unsafe(
      `create table if not exists "transactions_${sufijo}" partition of transactions
         for values in ('${companyId}')`,
    );

    const [u] = await owner`
      insert into users (workos_user_id, email)
      values ('wos_asesor_cola', 'asesor_cola@test.local') returning id
    `;
    const [d] = await owner`
      insert into documents (company_id, uploaded_by, s3_key, original_filename,
                             file_size_bytes, mime_type, status)
      values (${companyId}, ${u!.id}, ${`${companyId}/ventas.xlsx`}, 'ventas.xlsx',
              100, 'text/csv', 'promoted')
      returning id
    `;
    documentId = d!.id;
  });

  afterAll(async () => {
    await owner?.end();
  });

  async function insertTx(dia: number, monto: number, opts: { borrada?: boolean } = {}) {
    const fecha = `${PERIODO}-${String(dia).padStart(2, '0')}`;
    await owner`
      insert into transactions (company_id, document_id, date, type, category,
                                original_amount, original_currency, amount_base,
                                fx_rate, fx_rate_date, deleted_at)
      values (${companyId}, ${documentId}, ${fecha}, 'revenue', 'ventas',
              ${monto}, 'USD', ${monto}, 1, ${fecha},
              ${opts.borrada ? new Date().toISOString() : null}::timestamptz)
    `;
  }

  test('con más filas que el límite, viaja el total y la suma COMPLETA', async () => {
    /*
     * 30 ventas de USD 100 cada una. Con `limit: 10` el asesor recibe 10 —las más recientes—
     * que suman 1.000, y el total real es 3.000. Es la forma exacta del reporte: un subtotal de
     * la cola que parece la respuesta.
     */
    for (let dia = 1; dia <= 30; dia++) await insertTx(dia, 100);

    const crudo = await executeChatTool(ctx, 'query_transactions', {
      type: 'revenue',
      dateFrom: `${PERIODO}-01`,
      dateTo: `${PERIODO}-31`,
      limit: 10,
    });
    const r = JSON.parse(crudo) as {
      filasDevueltas: number;
      filasQueCoinciden: number;
      sumaDeTodasLasCoincidencias: number;
      aviso?: string;
      transacciones: { amountBase: string }[];
    };

    expect(r.filasDevueltas).toBe(10);
    expect(r.filasQueCoinciden).toBe(30);

    /*
     * LA CIFRA ES LO QUE IMPORTA, no el aviso. Decirle al modelo "hay 30 filas" y darle 10 lo
     * deja igual de incapaz de contestar cuánto vendió el mes; la suma completa, calculada en
     * Postgres sobre el MISMO `where`, es lo que convierte el aviso en algo accionable.
     */
    expect(r.sumaDeTodasLasCoincidencias).toBe(3_000);

    // Y la suma de lo devuelto sigue siendo el subtotal de la cola, que es lo que el asesor
    // sumaba antes sin saberlo.
    const subtotal = r.transacciones.reduce((a, t) => a + Number(t.amountBase), 0);
    expect(subtotal).toBe(1_000);
    expect(r.aviso).toContain('NO es el total del período');
  });

  test('sin recorte no hay aviso: no se le enseña a desconfiar de una lista completa', async () => {
    const crudo = await executeChatTool(ctx, 'query_transactions', {
      type: 'revenue',
      dateFrom: `${PERIODO}-01`,
      dateTo: `${PERIODO}-31`,
      limit: 50,
    });
    const r = JSON.parse(crudo) as {
      filasDevueltas: number;
      filasQueCoinciden: number;
      aviso?: string;
    };

    expect(r.filasDevueltas).toBe(r.filasQueCoinciden);
    expect(r.aviso).toBeUndefined();
  });

  test('las filas de una carga revertida NO se cuentan', async () => {
    /*
     * El caso que hace que las dos cifras del producto se contradigan sin que ninguna pueda
     * desmentir a la otra: el dashboard filtra `deleted_at` y el asesor no lo hacía, así que
     * una carga que el cliente deshizo seguía viva en la mitad del producto que responde en
     * lenguaje natural — que es justo la mitad donde nadie va a auditar de dónde salió el
     * número.
     */
    await insertTx(15, 99_999, { borrada: true });

    const crudo = await executeChatTool(ctx, 'query_transactions', {
      type: 'revenue',
      dateFrom: `${PERIODO}-01`,
      dateTo: `${PERIODO}-31`,
      limit: 50,
    });
    const r = JSON.parse(crudo) as {
      filasQueCoinciden: number;
      sumaDeTodasLasCoincidencias: number;
      transacciones: { amountBase: string }[];
    };

    expect(r.filasQueCoinciden).toBe(30);
    expect(r.sumaDeTodasLasCoincidencias).toBe(3_000);
    expect(r.transacciones.some((t) => Number(t.amountBase) === 99_999)).toBe(false);
  });
});
