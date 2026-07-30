import { describe, expect, test, beforeAll, afterAll } from 'bun:test';
import { drizzle } from 'drizzle-orm/postgres-js';
import { ownerConnection, setupTestDatabase } from './setup';
import * as schema from '@/db/schema';
import {
  getOrComputeMonthlyAmount,
  getOrComputeMonthlyAmounts,
  refreshExistingRollups,
} from '@/lib/rollups';
import type { DB } from '@/db/client';

/**
 * CU-868kh8w6b: la versión por lotes de los rollups contra un Postgres real.
 *
 * El ticket marcaba un riesgo concreto para este refactor: *"cualquier refactor debe
 * preservar que un período nunca visto se calcule y persista igual que hoy"*. Eso es
 * semántica de cache-aside, y no se puede verificar con un test unitario — vive en dos
 * queries de agregación y en un INSERT, no en lógica de JavaScript. Aquí se ejercita
 * contra la base de verdad, incluido el caso que más fácil se rompe: un período con
 * cero movimiento, que si no se persiste se recalcula en cada request para siempre.
 *
 * Se conecta con el rol DUEÑO a propósito: lo que se prueba es la semántica del cache,
 * no el aislamiento (eso es `tenant-isolation.test.ts`). Sembrar y leer con el rol
 * restringido obligaría a manejar el GUC en cada query y enturbiaría qué está fallando.
 */

const COMPANY_ORG = 'org_rollups';

// Períodos fijos y muy antiguos: no dependen del reloj y no chocan con datos de otros
// archivos de la suite (cada uno usa su propia empresa, pero el mes sí se comparte).
const P1 = '2019-01-01';
const P2 = '2019-02-01';
const P3_VACIO = '2019-03-01';

describe('cache-aside de rollups mensuales (CU-868kh8w6b)', () => {
  let owner: ReturnType<typeof ownerConnection>;
  let db: DB;
  let companyId: string;
  let documentId: string;

  beforeAll(async () => {
    await setupTestDatabase();
    owner = ownerConnection();
    db = drizzle(owner, { schema }) as unknown as DB;

    const [c] = await owner`
      insert into companies (workos_org_id, name, industry)
      values (${COMPANY_ORG}, 'Rollups SA', 'retail') returning id
    `;
    companyId = c!.id;

    // `transactions` está particionada por LIST (company_id): sin partición, el INSERT
    // falla. En producción esto lo hace `provisionTenantPartitions` en el onboarding.
    const suffix = companyId.replace(/-/g, '_');
    await owner.unsafe(
      `create table if not exists "transactions_${suffix}" partition of transactions
         for values in ('${companyId}')`,
    );

    const [u] = await owner`
      insert into users (workos_user_id, email)
      values ('wos_rollups', 'rollups@test.local') returning id
    `;
    const [d] = await owner`
      insert into documents (company_id, uploaded_by, s3_key, original_filename,
                             file_size_bytes, mime_type)
      values (${companyId}, ${u!.id}, ${`${companyId}/r`}, 'r.xlsx', 100, 'text/csv')
      returning id
    `;
    documentId = d!.id;

    await insertTx(P1, 'revenue', 1000);
    await insertTx(P1, 'revenue', 500); // dos filas del mismo mes: deben sumarse
    await insertTx(P1, 'cogs', 300);
    await insertTx(P2, 'revenue', 2000);
    await insertTx(P2, 'opex', 700);
    // P3_VACIO no tiene ninguna transacción: es el caso del comentario de rollups.ts.

    // Una fila borrada (soft-delete) que NO debe entrar en ninguna suma — es como la
    // reversión de una carga deja las filas, así que un rollup que la contara estaría
    // mostrando datos revertidos en el dashboard.
    await insertTx(P1, 'revenue', 9999, { deleted: true });
  });

  afterAll(async () => {
    await owner?.end();
  });

  async function insertTx(
    period: string,
    type: string,
    amount: number,
    opts: { deleted?: boolean } = {},
  ) {
    await owner`
      insert into transactions (company_id, document_id, date, type, category,
                                original_amount, original_currency, amount_base,
                                fx_rate, fx_rate_date, deleted_at)
      values (${companyId}, ${documentId}, ${period}, ${type}, 'test',
              ${amount}, 'GTQ', ${amount}, 1, ${period},
              ${opts.deleted ? new Date().toISOString() : null}::timestamptz)
    `;
  }

  async function rollupRows() {
    return owner`
      select period::text, type, amount_base::float8 as amount
      from metric_rollups
      where company_id = ${companyId} and granularity = 'month' and category is null
      order by period, type
    `;
  }

  test('calcula los cuatro tipos de cada período pedido en una sola pasada', async () => {
    const result = await getOrComputeMonthlyAmounts(db, companyId, [P1, P2, P3_VACIO]);

    expect(result.get(P1)).toEqual({ revenue: 1500, cogs: 300, opex: 0, other: 0 });
    expect(result.get(P2)).toEqual({ revenue: 0 + 2000, cogs: 0, opex: 700, other: 0 });
    expect(result.get(P3_VACIO)).toEqual({ revenue: 0, cogs: 0, opex: 0, other: 0 });
  });

  test('ignora las filas con deleted_at', async () => {
    // Si la suma incluyera la fila borrada, P1.revenue sería 11499 y no 1500. El test
    // anterior ya lo comprueba; este deja explícito POR QUÉ ese número es el correcto.
    const [row] = await owner`
      select count(*)::int as count from transactions
      where company_id = ${companyId} and deleted_at is not null
    `;
    expect(row!.count).toBe(1);
  });

  test('persiste TODOS los pares (período, tipo), incluidos los que suman 0', async () => {
    // El riesgo que marcaba el ticket: si un período sin movimiento no se cachea, se
    // recalcula en cada request para siempre. 3 períodos × 4 tipos = 12 filas.
    const rows = await rollupRows();
    expect(rows.length).toBe(12);

    const vacios = rows.filter((r: { period: string }) => r.period === P3_VACIO);
    expect(vacios.length).toBe(4);
    expect(vacios.every((r: { amount: number }) => r.amount === 0)).toBe(true);
  });

  test('un período ya cacheado se devuelve tal cual, sin recalcularse', async () => {
    // La prueba de que el cache es cache: se mete una transacción nueva en un mes ya
    // cacheado y el resultado NO cambia. Si cambiara, estaríamos recalculando en cada
    // lectura y el cache-aside no existiría.
    await insertTx(P1, 'revenue', 100000);

    const result = await getOrComputeMonthlyAmounts(db, companyId, [P1]);
    expect(result.get(P1)!.revenue).toBe(1500);

    const rows = await rollupRows();
    expect(rows.length).toBe(12); // tampoco se insertan filas duplicadas
  });

  test('mezcla cacheado y no cacheado en la misma llamada', async () => {
    // El caso realista de /metrics: la mayoría de meses ya están, uno o dos no. El que
    // falta se calcula y persiste; los que estaban se devuelven sin tocar.
    const P4 = '2019-04-01';
    await insertTx(P4, 'other', 42);

    const result = await getOrComputeMonthlyAmounts(db, companyId, [P1, P4]);
    expect(result.get(P1)!.revenue).toBe(1500); // cacheado, sigue igual
    expect(result.get(P4)!.other).toBe(42); // nuevo, calculado

    const rows = await rollupRows();
    expect(rows.length).toBe(16); // 12 + los 4 tipos de P4
  });

  test('la versión por lotes y la de una-en-una dan el mismo número', async () => {
    // Equivalencia con `getOrComputeMonthlyAmount`, que sigue en uso en chat-tools:
    // si las dos divergieran, el chat y el dashboard darían cifras distintas del mismo
    // mes al mismo usuario.
    const uno = await getOrComputeMonthlyAmount(db, companyId, P2, 'revenue');
    const lote = await getOrComputeMonthlyAmounts(db, companyId, [P2]);
    expect(uno).toBe(lote.get(P2)!.revenue);
  });

  test('sin períodos no toca la base y devuelve un mapa vacío', async () => {
    const result = await getOrComputeMonthlyAmounts(db, companyId, []);
    expect(result.size).toBe(0);
  });

  test('refreshExistingRollups pone al día lo cacheado tras una ingesta', async () => {
    // Es el hook de fin de ingesta: los 100000 que insertamos arriba y que el cache
    // seguía ignorando deben aparecer ahora. Los períodos nunca vistos siguen siendo
    // lazy — refresh solo toca lo que YA existe.
    await refreshExistingRollups(db, companyId);

    const result = await getOrComputeMonthlyAmounts(db, companyId, [P1]);
    expect(result.get(P1)!.revenue).toBe(101500);
    expect(result.get(P1)!.cogs).toBe(300);

    const rows = await rollupRows();
    expect(rows.length).toBe(16); // refresca en sitio, no acumula filas nuevas
  });
});
