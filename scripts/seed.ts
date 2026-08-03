/**
 * Data/seed script — SEPARATE from schema migrations (never mix). Idempotent-ish demo
 * data for local dev only. Real seed catalogs (alert rules, industry templates, insight
 * prompts) are curated by super_admin. Run: bun run db:seed
 */
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { companies, creditRules, industryTemplates, industryTemplateVersions } from '@/db/schema';
import { alertCatalog } from '@/config/alert-catalog';
import { seedDefaultAlertRules } from '@/lib/alert-rules-seed';
import { creditsConfig } from '@/config/credits';
import { setPlatformSetting, SETTINGS_KEYS } from '@/lib/settings';
import { DEFAULT_INSIGHT_PROMPT } from '@/lib/anthropic';

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

  // CU-868kfva91: primera plantilla de mapeo por industria (retail, matching la
  // empresa demo de arriba). Sin Excels de muestra reales de Macha (CU-868kfv9cb, en
  // backlog) todavía — sinónimos/few-shot son un primer pase razonable sobre la
  // taxonomía fija del PRD, a recalibrar cuando lleguen muestras reales (mismo
  // espíritu que "mecanismo ahora, números después" del resto de F0/F3).
  const [retailTemplate] = await db
    .insert(industryTemplates)
    .values({ industry: 'retail', name: 'Retail (GT) — v1' })
    .returning();

  const [retailVersion] = await db
    .insert(industryTemplateVersions)
    .values({
      templateId: retailTemplate!.id,
      version: 1,
      synonyms: {
        'revenue.sales': ['venta', 'ventas', 'venta de mostrador', 'ingresos por ventas', 'sales'],
        'revenue.other_income': ['otros ingresos', 'ingresos varios', 'other income'],
        'cogs.merchandise': [
          'compra de mercadería',
          'costo de mercadería vendida',
          'compras',
          'cost of goods sold',
          'cogs',
        ],
        'opex.rent': ['renta', 'alquiler', 'arrendamiento', 'rent'],
        'opex.payroll': ['planilla', 'sueldos', 'salarios', 'nómina', 'payroll', 'salaries'],
        'opex.utilities': ['servicios', 'luz', 'agua', 'electricidad', 'utilities'],
        'opex.marketing': ['publicidad', 'mercadeo', 'marketing'],
        'other.misc': ['otros', 'varios', 'misc', 'other'],
      },
      fewShot: [
        {
          input:
            "Fecha=15/01/2026, Descripción='Venta de mostrador enero', Monto=15000.00, Moneda=GTQ",
          output: {
            targetEntity: 'transaction',
            type: 'revenue',
            category: 'sales',
            date: '2026-01-15',
            description: 'Venta de mostrador enero',
            originalAmount: 15000.0,
            originalCurrency: 'GTQ',
          },
        },
        {
          input:
            "Fecha=20/01/2026, Descripción='Compra de mercadería a proveedor X', Monto=-8500.50, Moneda=GTQ",
          output: {
            targetEntity: 'transaction',
            type: 'cogs',
            category: 'merchandise',
            date: '2026-01-20',
            description: 'Compra de mercadería a proveedor X',
            originalAmount: 8500.5,
            originalCurrency: 'GTQ',
          },
        },
        {
          input:
            "Cliente='Ferretería Los Pinos', Fecha emisión=05/01/2026, Vence=05/02/2026, Monto=3200.00 GTQ",
          output: {
            targetEntity: 'invoice',
            counterparty: 'Ferretería Los Pinos',
            issueDate: '2026-01-05',
            dueDate: '2026-02-05',
            originalAmount: 3200.0,
            originalCurrency: 'GTQ',
          },
        },
      ],
      createdBy: randomUUID(), // placeholder — real staff identity resolution es CU-868kfvaex
    })
    .returning();

  await db
    .update(industryTemplates)
    .set({ currentVersionId: retailVersion!.id })
    .where(eq(industryTemplates.id, retailTemplate!.id));

  console.log('seeded industry template: retail v1', retailVersion?.id);

  // CU-868kfvad3: alert_rules es por empresa (nunca global) — este catálogo
  // (config/alert-catalog.ts, umbrales reales aprobados por Jose) es solo el default
  // que la provisión de empresa siembra. Sin flujo de onboarding real todavía (F7),
  // así que se siembra aquí para la empresa demo.
  await seedDefaultAlertRules(db, demo!.id);
  console.log(
    'seeded alert rules for demo company:',
    alertCatalog.map((e) => e.ruleKey).join(', '),
  );

  // CU-868kfvafy criterio 1: siembra los valores de arranque en platform_settings —
  // desde acá el admin los edita en el panel, el código nunca vuelve a hardcodearlos.
  await setPlatformSetting(
    db,
    SETTINGS_KEYS.creditToTokensRatio,
    creditsConfig.creditToTokensRatio,
  );
  await setPlatformSetting(
    db,
    SETTINGS_KEYS.creditMonthlyAllotment,
    creditsConfig.monthlyAllotment,
  );
  // CU-868kjc7g5 criterio 3: créditos de arranque de una empresa nueva. Mismo valor
  // provisional que la asignación mensual — el número real sigue abierto (PRD §12.4);
  // lo que ya no está abierto es que una empresa nazca en 0 y no pueda pedir un insight.
  await setPlatformSetting(db, SETTINGS_KEYS.creditInitialGrant, creditsConfig.monthlyAllotment);
  await setPlatformSetting(db, SETTINGS_KEYS.insightPromptTemplate, DEFAULT_INSIGHT_PROMPT);
  // CU-868kfvaet: precio provisional por crédito — sin confirmar con Jose/el owner.
  await setPlatformSetting(db, SETTINGS_KEYS.creditPriceUsdCents, 10);
  console.log('seeded platform_settings defaults');
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
