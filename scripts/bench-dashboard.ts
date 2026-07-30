/**
 * Benchmark antes/después de las rutas del dashboard — CU-868kh8w6b criterio 4
 * ("medición con un dataset sintético grande que justifique el cambio, no optimizar
 * a ciegas").
 *
 * Compara, sobre los MISMOS datos y en la misma base:
 *   - /metrics: el camino viejo (`getOrComputeMonthlyAmount`, un round-trip por
 *     período×tipo) contra el nuevo (`getOrComputeMonthlyAmounts`, 2 queries).
 *   - /ar-ap: traer todas las filas abiertas y agrupar en JavaScript, contra agrupar
 *     en SQL.
 *
 * NO es un test: no corre en CI ni bloquea el gate. Es una herramienta para justificar
 * (o descartar) una optimización con números propios. Se ejecuta a mano:
 *
 *   BENCH_DATABASE_URL=postgres://user@localhost:5432/mi_base bun run scripts/bench-dashboard.ts
 *
 * Usa una empresa sintética propia y borra sus datos al terminar.
 */
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as schema from '@/db/schema';
import { getOrComputeMonthlyAmount, getOrComputeMonthlyAmounts, ROLLUP_TYPES } from '@/lib/rollups';

const URL_ = process.env.BENCH_DATABASE_URL ?? process.env.DATABASE_URL;
if (!URL_) throw new Error('Set BENCH_DATABASE_URL (o DATABASE_URL)');

const MONTHS = 36; // el máximo que acepta el schema de /metrics
const TX_PER_MONTH = 2_000; // 72k transacciones
const OPEN_INVOICES = Number(process.env.BENCH_INVOICES ?? 20_000);

const sql = postgres(URL_, { max: 1, onnotice: () => {} });
const db = drizzle(sql, { schema });

function monthStart(monthsAgo: number): string {
  const d = new Date();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() - monthsAgo);
  return d.toISOString().slice(0, 10);
}

async function ms(label: string, fn: () => Promise<unknown>): Promise<number> {
  const t0 = performance.now();
  await fn();
  const elapsed = performance.now() - t0;
  console.log(`  ${label.padEnd(46)} ${elapsed.toFixed(0).padStart(7)} ms`);
  return elapsed;
}

console.log(`\nSembrando dataset sintético (${MONTHS} meses, ${MONTHS * TX_PER_MONTH} tx)…`);

const [company] = await sql`
  insert into companies (workos_org_id, name, industry)
  values (${`org_bench_${Date.now()}`}, ${`Bench ${Date.now()}`}, 'retail') returning id
`;
const companyId = company!.id as string;

// transactions/invoices/bills son PARTITION BY LIST (company_id): sin partición no se
// puede insertar nada para esta empresa.
const { provisionTenantPartitions } = await import('@/lib/tenant-provisioning');
await provisionTenantPartitions(companyId);

// transactions/invoices exigen document_id NOT NULL, y documents exige un usuario.
const [user] = await sql`
  insert into users (workos_user_id, email)
  values (${`wos_bench_${Date.now()}`}, ${`bench_${Date.now()}@test.local`}) returning id
`;
const [doc] = await sql`
  insert into documents (company_id, uploaded_by, s3_key, original_filename,
                         file_size_bytes, mime_type, status)
  values (${companyId}, ${user!.id}, 'bench/x', 'bench.xlsx', 1, 'text/csv', 'promoted')
  returning id
`;
const documentId = doc!.id as string;

const periods = Array.from({ length: MONTHS }, (_, i) => monthStart(MONTHS - 1 - i));

for (const period of periods) {
  await sql`
    insert into transactions (company_id, document_id, date, type, category, description,
                              original_amount, original_currency, amount_base, fx_rate,
                              fx_rate_date)
    select ${companyId}, ${documentId}, (${period}::date + (g % 27)), t.type, 'bench',
           'bench', 100, 'GTQ', 100, 1, ${period}::date
    from generate_series(1, ${Math.floor(TX_PER_MONTH / ROLLUP_TYPES.length)}) g
    cross join (select unnest(${ROLLUP_TYPES}::text[]) as type) t
  `;
}

await sql`
  insert into invoices (company_id, document_id, counterparty, issue_date, due_date,
                        status, original_amount, original_currency, amount_base,
                        fx_rate, fx_rate_date)
  select ${companyId}, ${documentId}, 'c', current_date - 200,
         current_date - (g % 200), 'open', 100, 'GTQ', 100, 1, current_date - 200
  from generate_series(1, ${OPEN_INVOICES}) g
`;

const [txRow] = await sql<{ count: number }[]>`
  select count(*)::int as count from transactions where company_id = ${companyId}
`;
const txCount = txRow!.count;
console.log(`Listo: ${txCount} transacciones, ${OPEN_INVOICES} facturas abiertas.\n`);

// ---------------------------------------------------------------------------
console.log(`/metrics — serie de ${MONTHS} meses × ${ROLLUP_TYPES.length} tipos`);

// Primera pasada: los rollups no existen, así que ambos caminos los calculan Y
// persisten. Se mide por separado del caso cacheado porque son cargas distintas.
const coldOld = await ms('ANTES  (N+1, cache frío)', async () => {
  for (const period of periods) {
    for (const type of ROLLUP_TYPES) {
      await getOrComputeMonthlyAmount(db, companyId, period, type);
    }
  }
});

await sql`delete from metric_rollups where company_id = ${companyId}`;

const coldNew = await ms('DESPUÉS (2 queries, cache frío)', () =>
  getOrComputeMonthlyAmounts(db, companyId, periods),
);

const warmOld = await ms('ANTES  (N+1, cache caliente)', async () => {
  for (const period of periods) {
    for (const type of ROLLUP_TYPES) {
      await getOrComputeMonthlyAmount(db, companyId, period, type);
    }
  }
});

const warmNew = await ms('DESPUÉS (2 queries, cache caliente)', () =>
  getOrComputeMonthlyAmounts(db, companyId, periods),
);

// ---------------------------------------------------------------------------
console.log(`\n/ar-ap — ${OPEN_INVOICES} facturas abiertas`);

let arOldRows = 0;
let arNewRows = 0;

const arOld = await ms('ANTES  (trae todo y agrupa en JS)', async () => {
  const rows = await sql`
    select due_date, amount_base from invoices
    where company_id = ${companyId} and status = 'open' and deleted_at is null
  `;
  arOldRows = rows.length;
  const today = new Date().toISOString().slice(0, 10);
  const totals: Record<string, number> = {};
  for (const row of rows) {
    const due = row.due_date as string | null;
    let bucket = 'current';
    if (due && due < today) {
      const days = Math.floor((new Date(today).getTime() - new Date(due).getTime()) / 86_400_000);
      bucket = days <= 30 ? '1_30' : days <= 60 ? '31_60' : days <= 90 ? '61_90' : '90_plus';
    }
    totals[bucket] = (totals[bucket] ?? 0) + Number(row.amount_base);
  }
  return totals;
});

const arNew = await ms('DESPUÉS (GROUP BY en SQL)', async () => {
  const rows = await sql`
  select case
      when due_date is null or due_date >= current_date then 'current'
      when current_date - due_date <= 30 then '1_30'
      when current_date - due_date <= 60 then '31_60'
      when current_date - due_date <= 90 then '61_90'
      else '90_plus'
    end as bucket,
    sum(amount_base) as total
  from invoices
    where company_id = ${companyId} and status = 'open' and deleted_at is null
    group by 1
  `;
  arNewRows = rows.length;
});

// ---------------------------------------------------------------------------
function speedup(before: number, after: number): string {
  return `${(before / after).toFixed(1)}× más rápido`;
}
console.log('\nResumen');
console.log(`  /metrics cache frío     ${speedup(coldOld, coldNew)}`);
console.log(`  /metrics cache caliente ${speedup(warmOld, warmNew)}`);
console.log(`  /ar-ap tiempo           ${speedup(arOld, arNew)}`);
// El tiempo no es la métrica que mueve /ar-ap: contra un Postgres local la
// transferencia es prácticamente gratis y los dos caminos empatan. Lo que cambia de
// verdad son las FILAS que cruzan la conexión y se materializan en memoria del
// proceso — y eso sí se degrada con la cartera y con la latencia real de red.
console.log(`  /ar-ap filas transferidas  ANTES ${arOldRows} → DESPUÉS ${arNewRows}`);

console.log('\nLimpiando…');
await sql`delete from invoices where company_id = ${companyId}`;
await sql`delete from transactions where company_id = ${companyId}`;
await sql`delete from metric_rollups where company_id = ${companyId}`;
await sql`delete from documents where company_id = ${companyId}`;
// Las particiones de esta empresa se localizan por pg_inherits en vez de reconstruir
// el nombre a mano: provisionTenantPartitions es quien decide cómo se llaman.
const partitions = await sql<{ child: string }[]>`
  select c.relname as child
  from pg_inherits i
  join pg_class c on c.oid = i.inhrelid
  join pg_class p on p.oid = i.inhparent
  where p.relname in ('transactions', 'invoices', 'bills')
    and pg_get_expr(c.relpartbound, c.oid) like ${'%' + companyId + '%'}
`;
for (const { child } of partitions) {
  // CASCADE: las FK compuestas cross-tenant (invoices/bills → transactions) apuntan a
  // la partición concreta, así que un DROP pelado se queda corto.
  await sql.unsafe(`drop table if exists ${child} cascade`);
}
await sql`delete from companies where id = ${companyId}`;
await sql.end();
console.log(`Listo (${partitions.length} particiones eliminadas).\n`);
