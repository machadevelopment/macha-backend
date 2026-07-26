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

  // CU-868kfv97x: motor de créditos — decisión final de Jose (reemplaza la lectura
  // parcial anterior): las 4 acciones tienen regla PROVISIONAL activa desde ya,
  // holgadas a propósito para que nadie choque contra el límite durante las pruebas
  // (el bloqueo duro sigue activo). Ningún valor es final — se definen con datos
  // reales de costo durante las pruebas. Esto supera lo que decía el PRD sobre
  // "excel/chat sin cap en v1" (ver nota en data model.md §13 y PRD.md).
  const [excelRule, chatRule, insightRule, reportRule] = await Promise.all([
    db
      .insert(creditRules)
      .values({
        actionKind: 'excel',
        ruleType: 'variable',
        creditsPerUnit: '1',
        unit: 'batch',
        version: 1,
        active: true,
      })
      .returning(),
    db
      .insert(creditRules)
      .values({
        actionKind: 'chat',
        ruleType: 'fixed',
        creditsPerUnit: '1',
        version: 1,
        active: true,
      })
      .returning(),
    db
      .insert(creditRules)
      .values({
        actionKind: 'insight',
        ruleType: 'fixed',
        creditsPerUnit: '1',
        version: 1,
        active: true,
      })
      .returning(),
    db
      .insert(creditRules)
      .values({
        actionKind: 'report_generation',
        ruleType: 'fixed',
        creditsPerUnit: '2',
        version: 1,
        active: true,
      })
      .returning(),
  ]);

  console.log(
    'seeded credit rules (v1, provisional, active): excel',
    excelRule[0]?.id,
    'chat',
    chatRule[0]?.id,
    'insight',
    insightRule[0]?.id,
    'report_generation',
    reportRule[0]?.id,
  );
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
