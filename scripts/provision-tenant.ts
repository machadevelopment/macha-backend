/**
 * Runner for scripts/provision_tenant.sql — creates the per-company LIST partitions
 * (transactions/invoices/bills) at company onboarding. Data model.md §6/§19: one
 * partition per company, created at provisioning, never in a global migration.
 *
 * `scripts/provision_tenant.sql` is kept as the documented reference template; this
 * runner does the equivalent work programmatically (table names can't hold a raw uuid
 * with dashes as an unquoted identifier, so the suffix is sanitized here).
 *
 * Run: bun run provision:tenant <company_id>
 */
import { sql } from '@/db/client';

const LEDGER_TABLES = ['transactions', 'invoices', 'bills'] as const;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function provisionTenant(companyId: string): Promise<void> {
  if (!UUID_RE.test(companyId)) {
    throw new Error(`Not a valid company_id (uuid): ${companyId}`);
  }
  const suffix = companyId.replace(/-/g, '_');

  for (const table of LEDGER_TABLES) {
    const partitionName = `${table}_${suffix}`;
    // No bind parameter for the value: CREATE TABLE ... PARTITION OF is DDL, and
    // Postgres's extended query protocol can't bind parameters into DDL at all (not
    // a type-inference issue — verified against a real instance: even an explicit
    // ::uuid cast still errors "could not determine data type of parameter $1",
    // because DDL isn't preparable in the first place). Safe to inline as a literal
    // since companyId is already regex-validated above (UUID_RE) before reaching here.
    await sql.unsafe(
      `CREATE TABLE IF NOT EXISTS "${partitionName}" PARTITION OF ${table} FOR VALUES IN ('${companyId}')`,
    );
    console.log('provisioned partition:', partitionName);
  }
}

const companyId = process.argv[2];
if (!companyId) {
  console.error('Usage: bun run provision:tenant <company_id>');
  process.exit(1);
}

provisionTenant(companyId)
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
