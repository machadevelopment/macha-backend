/**
 * FLUJO COMPLETO, DE PUNTA A PUNTA.
 *
 * Lo que corre de verdad: el worker de ingesta, el pre-filtro, la huella de fila, el
 * planificador de lotes, las llamadas a Claude, el ensamblado, `staging_rules`, la inserción
 * en staging, el débito de créditos, el ledger `ai_usage_events` y la promoción a
 * `transactions`. Contra Postgres real, con el rol `macha_app` real.
 *
 * Lo único sustituido es lo que sale de la máquina: S3 (se lee el .xlsx del disco) y pg-boss
 * (se captura el handler que el worker registra, igual que hace el test de integración).
 *
 * Se corre DOS veces sobre el mismo archivo: la primera mide el costo real, la segunda mide
 * cuánto cuesta la resubida semanal.
 */
import { readFileSync } from 'node:fs';
import { mock } from 'bun:test';
import { setupTestDatabase, ownerConnection, testOwnerUrl, testAppUrl } from './setup';

process.env.DATABASE_URL = testOwnerUrl;
process.env.APP_DATABASE_URL = testAppUrl;

const RUTA = process.argv[2]!;
const libro = readFileSync(RUTA);

mock.module('@/lib/s3', () => ({ downloadObject: async () => libro }));

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

/*
 * Mismo arranque que `tests/integration/run.ts`, y en el mismo orden que el despliegue real:
 * esquema limpio → migraciones con el dueño → crear `macha_app` → re-aplicar (el GRANT/REVOKE
 * de 0010 solo surte efecto una vez que el rol existe). Sin el segundo pase, las garantías de
 * append-only quedarían sin efecto y esta prueba no mediría el sistema real.
 */
{
  const boot = (await import('postgres')).default(testOwnerUrl, { max: 1, onnotice: () => {} });
  await boot.unsafe('drop schema if exists public cascade; create schema public;');
  await boot.end();
}
const migrar = async () => {
  const p = Bun.spawn(['bun', 'run', 'src/db/migrate.ts'], {
    env: { ...process.env, DATABASE_URL: testOwnerUrl },
    stdout: 'ignore',
    stderr: 'inherit',
  });
  if ((await p.exited) !== 0) throw new Error('migraciones fallaron');
};
await migrar();
await setupTestDatabase();
await migrar();

const owner = ownerConnection();

const [c] = await owner`
  insert into companies (workos_org_id, name, industry, base_currency)
  values ('wos_e2e', 'Luz de Cera SA', 'retail', 'GTQ') returning id`;
const companyId = c!.id as string;

// `transactions`/`invoices`/`bills` están particionadas por LIST (company_id): sin partición
// la promoción falla. En producción lo hace `provisionTenantPartitions`.
const suffix = companyId.replace(/-/g, '_');
for (const tabla of ['transactions', 'invoices', 'bills']) {
  await owner.unsafe(
    `create table if not exists "${tabla}_${suffix}" partition of ${tabla}
       for values in ('${companyId}')`,
  );
}

const [u] = await owner`
  insert into users (workos_user_id, email) values ('wos_e2e', 'e2e@test.local') returning id`;
const [t] = await owner`
  insert into industry_templates (industry, name) values ('retail', 'Retail') returning id`;
const [tv] = await owner`
  insert into industry_template_versions (template_id, version, synonyms, few_shot, created_by)
  values (${t!.id}, 1, '{}'::jsonb, '[]'::jsonb, ${u!.id}) returning id`;
await owner`update industry_templates set current_version_id = ${tv!.id} where id = ${t!.id}`;
await owner`
  insert into credit_rules (action_kind, rule_type, credits_per_unit, unit, version, active)
  values ('excel', 'variable', 1, 'batch', 1, true)`;

await startExcelIngestWorker();

const num = async (sql: string): Promise<number> => Number((await owner.unsafe(sql))[0]!.n);

async function correr(etiqueta: string): Promise<void> {
  const [d] = await owner`
    insert into documents (company_id, uploaded_by, s3_key, original_filename,
                           file_size_bytes, mime_type)
    values (${companyId}, ${u!.id}, ${`${companyId}/f`}, ${RUTA.split('/').pop()!},
            ${libro.length}, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    returning id`;
  const documentId = d!.id as string;

  console.log(`\n═══ ${etiqueta} ═══`);
  const t0 = Date.now();
  await handler!({ documentId, companyId });
  const seg = (Date.now() - t0) / 1000;

  const [uso] = await owner.unsafe(`
    select count(*)::int as llamadas,
           coalesce(sum(input_tokens),0)::int  as inp,
           coalesce(sum(output_tokens),0)::int as out,
           coalesce(sum(cache_read_input_tokens),0)::int as cread,
           coalesce(sum(cache_creation_input_tokens),0)::int as cwrite,
           coalesce(sum(cost_usd),0)::numeric  as usd,
           coalesce(sum(billable_units),0)::int as filas
      from ai_usage_events where ref_id = '${documentId}' and kind = 'excel'`);

  const [doc] = await owner.unsafe(
    `select status, row_count, flagged_count, error_reason from documents where id = '${documentId}'`,
  );

  const staging = await num(
    `select count(*)::int n from staging_rows where document_id='${documentId}'`,
  );
  const promovidas = await num(
    `select count(*)::int n from staging_rows where document_id='${documentId}' and promoted_at is not null`,
  );
  const marcadas = await num(
    `select count(*)::int n from staging_rows where document_id='${documentId}' and flag_reason is not null`,
  );
  const trx = await num(
    `select count(*)::int n from transactions where document_id='${documentId}'`,
  );
  const inv = await num(`select count(*)::int n from invoices where document_id='${documentId}'`);
  const bills = await num(`select count(*)::int n from bills where document_id='${documentId}'`);
  const huellas = await num(
    `select count(*)::int n from ingested_rows where company_id='${companyId}'`,
  );
  const creditos = await num(
    `select coalesce(sum(delta),0)::int n from credit_transactions where company_id='${companyId}'`,
  );

  console.log(`  TIEMPO DE PARED   ${seg.toFixed(1)} s   (${(seg / 60).toFixed(2)} min)`);
  console.log(
    `  documento         status=${doc!.status} row_count=${doc!.row_count} flagged=${doc!.flagged_count}`,
  );
  if (doc!.error_reason) console.log(`  error_reason      ${doc!.error_reason}`);
  console.log(`  llamadas a Claude ${uso!.llamadas}   (filas facturadas: ${uso!.filas})`);
  console.log(
    `  tokens            in ${Number(uso!.inp).toLocaleString('es')} · out ${Number(uso!.out).toLocaleString('es')}`,
  );
  console.log(
    `  caché             leído ${Number(uso!.cread).toLocaleString('es')} · escrito ${Number(uso!.cwrite).toLocaleString('es')}`,
  );
  console.log(`  COSTO (ledger)    USD ${Number(uso!.usd).toFixed(4)}`);
  console.log(
    `  staging           ${staging} filas · ${marcadas} marcadas · ${promovidas} promovidas`,
  );
  console.log(`  promovido a       transactions=${trx} invoices=${inv} bills=${bills}`);
  console.log(`  huellas guardadas ${huellas}`);
  console.log(`  créditos debitados ${creditos}`);
  if (uso!.filas > 0) {
    console.log(`  salida por fila   ${(Number(uso!.out) / Number(uso!.filas)).toFixed(1)} tokens`);
    console.log(
      `  costo /1000 filas USD ${((Number(uso!.usd) / Number(uso!.filas)) * 1000).toFixed(2)}`,
    );
  }
}

await correr('PRIMERA SUBIDA');
await correr('SEGUNDA SUBIDA — mismo archivo, una semana después');

await owner.end();
