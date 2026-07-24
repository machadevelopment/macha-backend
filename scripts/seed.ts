/**
 * Data/seed script — SEPARATE from schema migrations (never mix). Idempotent-ish demo
 * data for local dev only. Real seed catalogs (alert rules, industry templates, insight
 * prompts) are curated by super_admin. Run: bun run db:seed
 */
import { db } from '@/db/client';
import { companies } from '@/db/schema';

async function main() {
  const [demo] = await db.insert(companies).values({
    workosOrgId: 'org_demo_local',
    name: 'Demo Retail GT',
    industry: 'retail',
    baseCurrency: 'GTQ',
    status: 'active',
    locale: 'es',
  }).returning();

  console.log('seeded company:', demo?.id);
  // NOTE: per-tenant ledger partitions must be provisioned separately
  // (scripts/provision_tenant.sql) before inserting transactions/invoices/bills.
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
