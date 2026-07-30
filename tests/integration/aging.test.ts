import { describe, expect, test, beforeAll, afterAll } from 'bun:test';
import { drizzle } from 'drizzle-orm/postgres-js';
import { and, eq, isNull, sql as rawSql } from 'drizzle-orm';
import { ownerConnection, setupTestDatabase } from './setup';
import * as schema from '@/db/schema';
import { invoices } from '@/db/schema';
import { AGING_BUCKET_SQL, emptyAgingBuckets, type AgingBucket } from '@/lib/aging';
import type { DB } from '@/db/client';

/**
 * CU-868kh8w6b: los bordes de los tramos de antigüedad de AR/AP, contra Postgres real.
 *
 * La clasificación pasó de un `bucketFor()` en JavaScript a un `CASE` en SQL. La
 * traducción es literal, pero los bordes (30/60/90 días exactos) son justo donde un
 * off-by-one no se nota mirando el dashboard: una factura de 31 días de atraso que cae
 * en el tramo equivocado sigue "pareciendo" correcta. Por eso cada borde se prueba con
 * su día exacto y con el día siguiente.
 *
 * Se usa `current_date - due_date`, no el reloj del proceso, así que los datos se
 * siembran relativos a `current_date` en la propia base.
 */
describe('tramos de antigüedad de AR/AP (CU-868kh8w6b)', () => {
  let owner: ReturnType<typeof ownerConnection>;
  let db: DB;
  let companyId: string;

  beforeAll(async () => {
    await setupTestDatabase();
    owner = ownerConnection();
    db = drizzle(owner, { schema }) as unknown as DB;

    const [c] = await owner`
      insert into companies (workos_org_id, name, industry)
      values ('org_aging', 'Aging SA', 'retail') returning id
    `;
    companyId = c!.id;

    const suffix = companyId.replace(/-/g, '_');
    await owner.unsafe(
      `create table if not exists "invoices_${suffix}" partition of invoices
         for values in ('${companyId}')`,
    );

    const [u] = await owner`
      insert into users (workos_user_id, email)
      values ('wos_aging', 'aging@test.local') returning id
    `;
    const [d] = await owner`
      insert into documents (company_id, uploaded_by, s3_key, original_filename,
                             file_size_bytes, mime_type)
      values (${companyId}, ${u!.id}, ${`${companyId}/a`}, 'a.xlsx', 100, 'text/csv')
      returning id
    `;
    const documentId = d!.id;

    // Un importe distinto por caso para que el total de cada tramo diga exactamente qué
    // filas cayeron en él: si un borde se corre, el número no cuadra por un valor único.
    const casos: [dias: number | null, monto: number][] = [
      [null, 1], // sin fecha de vencimiento → current
      [-5, 2], // vence en el futuro → current
      [0, 4], // vence hoy → current (due_date >= current_date)
      [1, 8], // 1 día de atraso → 1_30
      [30, 16], // borde exacto → 1_30
      [31, 32], // 1 día más → 31_60
      [60, 64], // borde exacto → 31_60
      [61, 128], // → 61_90
      [90, 256], // borde exacto → 61_90
      [91, 512], // → 90_plus
    ];

    for (const [dias, monto] of casos) {
      await owner`
        insert into invoices (company_id, document_id, counterparty, issue_date, due_date,
                              original_amount, original_currency, amount_base,
                              fx_rate, fx_rate_date, status)
        values (${companyId}, ${documentId}, 'ACME', current_date - 200,
                current_date - ${dias}::int,
                ${monto}, 'GTQ', ${monto}, 1, current_date - 200, 'open')
      `;
    }

    // Una factura pagada y una borrada: ninguna debe contarse. El filtro vive en la
    // ruta, pero la query de agregación es la misma, así que se replica aquí.
    await owner`
      insert into invoices (company_id, document_id, counterparty, issue_date, due_date,
                            original_amount, original_currency, amount_base,
                            fx_rate, fx_rate_date, status, deleted_at)
      values (${companyId}, ${documentId}, 'ACME', current_date - 200, current_date - 200,
              100000, 'GTQ', 100000, 1, current_date - 200, 'paid', null),
             (${companyId}, ${documentId}, 'ACME', current_date - 200, current_date - 200,
              200000, 'GTQ', 200000, 1, current_date - 200, 'open', now())
    `;
  });

  afterAll(async () => {
    await owner?.end();
  });

  /** Misma query que sirve `/ar-ap`, sin pasar por guards ni rate limiting. */
  async function buckets(): Promise<Record<AgingBucket, number>> {
    const rows = await db
      .select({ bucket: AGING_BUCKET_SQL.as('bucket'), total: rawSql<string>`sum(amount_base)` })
      .from(invoices)
      .where(
        and(
          eq(invoices.companyId, companyId),
          eq(invoices.status, 'open'),
          isNull(invoices.deletedAt),
        ),
      )
      .groupBy(AGING_BUCKET_SQL);

    const totals = emptyAgingBuckets();
    for (const row of rows) totals[row.bucket] = Number(row.total);
    return totals;
  }

  test('clasifica cada factura en su tramo, con los bordes en 30/60/90', async () => {
    expect(await buckets()).toEqual({
      current: 1 + 2 + 4, // sin vencimiento, futura y vence hoy
      '1_30': 8 + 16, // 1 y 30 días de atraso
      '31_60': 32 + 64, // 31 y 60
      '61_90': 128 + 256, // 61 y 90
      '90_plus': 512, // 91
    });
  });

  test('la agregación devuelve como mucho una fila por tramo, no la cartera entera', async () => {
    // El objetivo del ticket no era tiempo sino transferencia: /ar-ap traía TODAS las
    // filas abiertas para devolver 10 números. Aquí se comprueba la forma del resultado.
    const rows = await db
      .select({ bucket: AGING_BUCKET_SQL.as('bucket') })
      .from(invoices)
      .where(
        and(
          eq(invoices.companyId, companyId),
          eq(invoices.status, 'open'),
          isNull(invoices.deletedAt),
        ),
      )
      .groupBy(AGING_BUCKET_SQL);

    expect(rows.length).toBeLessThanOrEqual(5);

    const [abiertas] = await owner`
      select count(*)::int as count from invoices
      where company_id = ${companyId} and status = 'open' and deleted_at is null
    `;
    expect(abiertas!.count).toBe(10); // 10 filas de entrada → 5 tramos de salida
  });
});
