/**
 * Data/seed script — SEPARATE from schema migrations (never mix). Idempotent-ish demo
 * data for local dev only. Real seed catalogs (alert rules, industry templates, insight
 * prompts) are curated by super_admin. Run: bun run db:seed
 */
import { db } from '@/db/client';
import { companies, creditRules } from '@/db/schema';

async function main() {
  const [demo] = await db
    .insert(companies)
    .values({
      workosOrgId: 'org_demo_local',
      name: 'Demo Retail GT',
      industry: 'retail',
      baseCurrency: 'GTQ',
      status: 'active',
      locale: 'es',
    })
    .returning();

  console.log('seeded company:', demo?.id);
  // NOTE: per-tenant ledger partitions must be provisioned separately
  // (scripts/provision_tenant.sql) before inserting transactions/invoices/bills.

  // CU-868kfv97x: motor de créditos — SOLO insight tiene regla activa en v1, per
  // PRD/CLAUDE.md ("excel/chat: solo visibilidad, sin cap"). Valor placeholder para
  // que el sistema arranque, no propuesta comercial (Jose: los números se definen
  // con datos reales de las pruebas).
  const [insightRule] = await db
    .insert(creditRules)
    .values({
      actionKind: 'insight',
      ruleType: 'fixed',
      creditsPerUnit: '1',
      version: 1,
      active: true,
    })
    .returning();

  console.log('seeded credit rule (insight, v1, active):', insightRule?.id);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
