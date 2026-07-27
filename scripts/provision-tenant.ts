/**
 * CLI runner for provisionTenantPartitions() (lib/tenant-provisioning.ts) — creates
 * the per-company LIST partitions (transactions/invoices/bills) at company onboarding.
 * Data model.md §6/§19: one partition per company, created at provisioning, never in
 * a global migration. Also used directly by admin/companies.ts's manual company
 * creation (CU-868kfvaf5) — this file is just the standalone CLI entry point.
 *
 * `scripts/provision_tenant.sql` is kept as the documented reference template.
 *
 * Run: bun run provision:tenant <company_id>
 */
import { provisionTenantPartitions } from '@/lib/tenant-provisioning';

const companyId = process.argv[2];
if (!companyId) {
  console.error('Usage: bun run provision:tenant <company_id>');
  process.exit(1);
}

provisionTenantPartitions(companyId)
  .then((partitions) => {
    for (const p of partitions) console.log('provisioned partition:', p);
    process.exit(0);
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
