import { pgTable, uuid, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';

// 4.1 companies — tenant root. base_currency/status enforced by CHECK in SQL migration.
export const companies = pgTable(
  'companies',
  {
    id: uuid('id').primaryKey().defaultRandom(), // == company_id everywhere + partition key
    workosOrgId: text('workos_org_id').notNull(),
    name: text('name').notNull(),
    industry: text('industry').notNull(), // auto-selects industry_templates on ingest
    baseCurrency: text('base_currency').$type<'GTQ' | 'USD'>().notNull().default('GTQ'),
    status: text('status').$type<'active' | 'suspended'>().notNull().default('active'),
    locale: text('locale').$type<'es' | 'en'>().notNull().default('es'),
    /**
     * CU-868kjc7t0, migración 0023. Preferencia de reportes AUTOMÁTICOS: el tick diario
     * (queue/workers/report-tick.ts) solo encola a quien toca en esa corrida. Default
     * 'weekly' — diario es una decisión que el cliente toma activamente, no hereda.
     *
     * NO es `reports.frequency`: aquélla registra con qué frecuencia nació cada reporte ya
     * creado (histórico), ésta dice qué debe generarse en adelante.
     *
     * El catálogo se escribe a mano aquí, en vez de importar `ReportFrequency` de
     * `lib/report-schedule.ts`, para que los archivos de `db/schema/` sigan sin depender de
     * nada más que Drizzle: los scripts de `scripts/` los cargan sueltos. El CHECK de la
     * migración 0023 es lo que mantiene honestas a las dos declaraciones.
     */
    reportFrequency: text('report_frequency')
      .$type<'daily' | 'weekly' | 'off'>()
      .notNull()
      .default('weekly'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    workosOrgUq: uniqueIndex('companies_workos_org_uq').on(t.workosOrgId),
  }),
);
