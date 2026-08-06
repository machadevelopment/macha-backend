import { describe, expect, test, beforeAll, afterAll } from 'bun:test';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';
import { ownerConnection, setupTestDatabase } from './setup';
import * as schema from '@/db/schema';
import { promoteDocument } from '@/lib/promotion';
import { insertStagingRows } from '@/lib/staging';
import { MISSING_FX_FLAG } from '@/lib/fx';
import type { DB } from '@/db/client';

/**
 * CU-868kjc6h1 criterio 4: promover un documento con filas en DOS monedas, con y sin
 * tasa registrada.
 *
 * Es un test de integración y no unitario porque lo que se prueba es exactamente lo que
 * no cabe en una función pura: que la promoción sea atómica (una fila sin tasa deja
 * fuera hasta las filas de la moneda base), que el mensaje de fallo llegue a
 * `documents.error_reason`, y que registrar la tasa desbloquee el mismo documento sin
 * tocar nada más.
 *
 * Se conecta con el rol dueño, igual que rollups.test.ts: aquí se prueba la conversión,
 * no el aislamiento (eso es tenant-isolation.test.ts).
 */

const P = '2026-02-10';

describe('conversión de moneda en la promoción (CU-868kjc6h1)', () => {
  let owner: ReturnType<typeof ownerConnection>;
  let db: DB;
  let companyId: string;
  let userId: string;

  beforeAll(async () => {
    await setupTestDatabase();
    owner = ownerConnection();
    db = drizzle(owner, { schema }) as unknown as DB;

    const [c] = await owner`
      insert into companies (workos_org_id, name, industry, base_currency)
      values ('org_fx', 'FX SA', 'retail', 'GTQ') returning id
    `;
    companyId = c!.id;

    const suffix = companyId.replace(/-/g, '_');
    for (const table of ['transactions', 'invoices', 'bills']) {
      await owner.unsafe(
        `create table if not exists "${table}_${suffix}" partition of ${table}
           for values in ('${companyId}')`,
      );
    }

    const [u] = await owner`
      insert into users (workos_user_id, email)
      values ('wos_fx', 'fx@test.local') returning id
    `;
    userId = u!.id;
  });

  afterAll(async () => {
    await owner?.end();
  });

  async function newDocument(): Promise<string> {
    const [d] = await owner`
      insert into documents (company_id, uploaded_by, s3_key, original_filename,
                             file_size_bytes, mime_type)
      values (${companyId}, ${userId}, ${`${companyId}/fx`}, 'fx.xlsx', 100, 'text/csv')
      returning id
    `;
    return d!.id;
  }

  /** Una fila limpia de staging, lista para promoverse (sin pasar por el clasificador). */
  async function stageTransaction(documentId: string, currency: 'GTQ' | 'USD', amount: number) {
    await owner`
      insert into staging_rows (company_id, document_id, target_entity, payload,
                                confidence, review_status)
      values (${companyId}, ${documentId}, 'transaction',
              ${JSON.stringify({
                type: 'revenue',
                category: 'ventas',
                date: P,
                originalAmount: amount,
                originalCurrency: currency,
              })}::jsonb,
              0.99, 'clean')
    `;
  }

  test('sin tasa registrada, la carga entera no entra y el error dice qué falta', async () => {
    const documentId = await newDocument();
    await stageTransaction(documentId, 'GTQ', 100);
    await stageTransaction(documentId, 'USD', 50);

    let message = '';
    try {
      // Dentro de una transacción a propósito: es la condición que `promoteDocument`
      // documenta y la que el worker cumple vía `withCompanyScope`. Sin ella el throw
      // dejaría confirmada la fila en moneda base, que es justo lo contrario de la
      // promoción todo-o-nada de CU-868kfva9z.
      await db.transaction((tx) => promoteDocument(tx as unknown as DB, companyId, documentId));
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }

    // Criterio 3: accionable, no `No fx_rate for company <uuid>`.
    expect(message).toContain('USD→GTQ');
    expect(message).toContain(P);
    expect(message).toContain('panel admin');

    // Y la atomicidad: ni siquiera la fila que SÍ estaba en la moneda base entró. Este
    // es el daño que hace faltar una tasa — no se pierde una fila, se pierde la carga.
    const [row] = await owner`
      select count(*)::int as count from transactions where document_id = ${documentId}
    `;
    expect(row!.count).toBe(0);
  });

  test('con la tasa registrada, el mismo documento promueve y convierte', async () => {
    const documentId = await newDocument();
    await stageTransaction(documentId, 'GTQ', 100);
    await stageTransaction(documentId, 'USD', 50);

    await owner`
      insert into fx_rates (company_id, base_currency, quote_currency, rate, effective_date)
      values (${companyId}, 'GTQ', 'USD', 7.75, '2026-01-01')
    `;

    const result = await promoteDocument(db, companyId, documentId);
    expect(result).toMatchObject({ promoted: true, transactionCount: 2 });

    const rows = await owner`
      select original_currency, amount_base::float8 as base, fx_rate::float8 as rate,
             fx_rate_date::text as rate_date
      from transactions where document_id = ${documentId}
      order by original_currency
    `;
    // La moneda base no necesita fila en el catálogo: convierte a 1.
    expect(rows[0]).toMatchObject({ original_currency: 'GTQ', base: 100, rate: 1 });
    // 50 USD × 7.75 = 387.5, con la tasa y su fecha congeladas en la fila.
    expect(rows[1]).toMatchObject({
      original_currency: 'USD',
      base: 387.5,
      rate: 7.75,
      rate_date: '2026-01-01',
    });
  });

  test('una tasa posterior a la fila no la cubre: la vigencia es hacia atrás', async () => {
    const documentId = await newDocument();
    // Fecha anterior a la única tasa del catálogo (2026-01-01).
    await owner`
      insert into staging_rows (company_id, document_id, target_entity, payload,
                                confidence, review_status)
      values (${companyId}, ${documentId}, 'transaction',
              ${JSON.stringify({
                type: 'revenue',
                category: 'ventas',
                date: '2025-06-30',
                originalAmount: 10,
                originalCurrency: 'USD',
              })}::jsonb,
              0.99, 'clean')
    `;

    let message = '';
    try {
      await promoteDocument(db, companyId, documentId);
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain('2025-06-30');
  });

  test('registrar la tasa NO recalcula lo ya promovido (criterio 5)', async () => {
    const [before] = await owner`
      select fx_rate::float8 as rate from transactions
      where company_id = ${companyId} and original_currency = 'USD' and date = ${P}
      limit 1
    `;

    await owner`
      insert into fx_rates (company_id, base_currency, quote_currency, rate, effective_date)
      values (${companyId}, 'GTQ', 'USD', 8.5, '2026-02-01')
    `;

    const [after] = await owner`
      select fx_rate::float8 as rate from transactions
      where company_id = ${companyId} and original_currency = 'USD' and date = ${P}
      limit 1
    `;
    // La foto por fila es lo que hace auditable una cifra histórica.
    expect(after!.rate).toBe(before!.rate);
    expect(after!.rate).toBe(7.75);
  });

  test('al clasificar, una fila sin tasa vigente se marca en vez de tumbar el documento', async () => {
    const documentId = await newDocument();

    await insertStagingRows(db, companyId, documentId, [
      {
        targetEntity: 'transaction',
        payload: {
          type: 'revenue',
          category: 'ventas',
          date: '2024-01-15', // antes de toda tasa del catálogo
          originalAmount: 10,
          originalCurrency: 'USD',
        },
        confidence: 0.95,
      },
      {
        targetEntity: 'transaction',
        payload: {
          type: 'revenue',
          category: 'ventas',
          date: '2024-01-15',
          originalAmount: 20,
          originalCurrency: 'GTQ', // moneda base: nunca necesita tasa
        },
        confidence: 0.95,
      },
    ]);

    const rows = await owner`
      select original_currency, flag_reason, review_status from (
        select payload->>'originalCurrency' as original_currency, flag_reason, review_status
        from staging_rows where document_id = ${documentId}
      ) s order by original_currency
    `;

    expect(rows[0]).toMatchObject({ original_currency: 'GTQ', review_status: 'clean' });
    expect(rows[0]!.flag_reason).toBeNull();
    expect(rows[1]!.review_status).toBe('pending');
    expect(rows[1]!.flag_reason).toBe(`${MISSING_FX_FLAG}:USD:2024-01-15`);

    // Y el efecto que importa: el documento queda para revisión, no fallido — las filas
    // siguen ahí, esperando a que alguien registre la tasa.
    const promotion = await promoteDocument(db, companyId, documentId);
    // `pendingCount` se agregó en CU-868kn5hqu: es lo que deja que el cliente sepa
    // CUÁNTAS filas frenan su carga en vez de ver el dashboard en cero sin explicación.
    expect(promotion).toEqual({ promoted: false, reason: 'pending_rows', pendingCount: 1 });

    await db
      .update(schema.documents)
      .set({ status: 'review' })
      .where(eq(schema.documents.id, documentId));
  });
});
