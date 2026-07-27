import postgres from 'postgres';
import { env } from '@/lib/env';

const LEDGER_TABLES = ['transactions', 'invoices', 'bills'] as const;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Dedicated connection using the OWNER role (env.databaseUrl), not db/client.ts's
// `sql` (env.appDatabaseUrl / macha_app, migration 0010). Attaching a partition to an
// existing partitioned table requires actually OWNING the parent table in Postgres —
// verified against a real instance: macha_app failed with "must be owner of table
// transactions" even with CREATE on the schema and full DML grants. There's no
// privilege that substitutes for ownership here, so this one DDL operation has to run
// as the owner regardless of which role serves the rest of the request.
const ownerSql = postgres(env.databaseUrl, { max: 1 });

/**
 * Shared by scripts/provision-tenant.ts (CLI) and admin/companies.ts's manual company
 * creation (CU-868kfvaf5 criterio 1: "aprovisiona partición vía T20"). Creates the
 * per-company LIST partitions — data model.md §6/§19, never in a global migration.
 *
 * No bind parameter for the value: CREATE TABLE ... PARTITION OF is DDL, and
 * Postgres's extended query protocol can't bind parameters into DDL at all (verified
 * against a real instance in PR #27 — even an explicit ::uuid cast still errors).
 * Safe to inline as a literal since companyId is regex-validated first.
 */
export async function provisionTenantPartitions(companyId: string): Promise<string[]> {
  if (!UUID_RE.test(companyId)) {
    throw new Error(`Not a valid company_id (uuid): ${companyId}`);
  }
  const suffix = companyId.replace(/-/g, '_');
  const created: string[] = [];

  for (const table of LEDGER_TABLES) {
    const partitionName = `${table}_${suffix}`;
    await ownerSql.unsafe(
      `CREATE TABLE IF NOT EXISTS "${partitionName}" PARTITION OF ${table} FOR VALUES IN ('${companyId}')`,
    );
    // FORCE ROW LEVEL SECURITY on the parent (migration 0010) does NOT propagate to
    // partitions for direct-by-name access (verified against a real instance: a
    // session with app.company_id set to company A could still read company B's
    // partition when queried by its literal table name, bypassing the parent
    // entirely). Each partition needs its own RLS enable/force/policy — normal app
    // queries go through the parent table name and are unaffected either way.
    await ownerSql.unsafe(`ALTER TABLE "${partitionName}" ENABLE ROW LEVEL SECURITY`);
    await ownerSql.unsafe(`ALTER TABLE "${partitionName}" FORCE ROW LEVEL SECURITY`);
    await ownerSql.unsafe(`
      DO $do$
      BEGIN
        EXECUTE format(
          'CREATE POLICY %I ON %I USING (company_id = current_setting(''app.company_id'', true)::uuid)',
          '${partitionName}_tenant_isolation', '${partitionName}'
        );
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $do$;
    `);
    created.push(partitionName);
  }
  return created;
}
