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
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    workosOrgUq: uniqueIndex('companies_workos_org_uq').on(t.workosOrgId),
  }),
);
