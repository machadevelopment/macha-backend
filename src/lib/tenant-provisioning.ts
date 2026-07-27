import { sql } from '@/db/client';

const LEDGER_TABLES = ['transactions', 'invoices', 'bills'] as const;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
    await sql.unsafe(
      `CREATE TABLE IF NOT EXISTS "${partitionName}" PARTITION OF ${table} FOR VALUES IN ('${companyId}')`,
    );
    created.push(partitionName);
  }
  return created;
}
