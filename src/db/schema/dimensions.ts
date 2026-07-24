import { pgTable, uuid, text, numeric, date, timestamp, uniqueIndex, index } from 'drizzle-orm/pg-core';
import { companies } from './companies';

// 4.8 products — optional enrichment dimension. Referenced via composite (company_id,id) FK.
export const products = pgTable('products', {
  id: uuid('id').primaryKey().defaultRandom(),
  companyId: uuid('company_id').notNull().references(() => companies.id),
  name: text('name').notNull(),
  externalRef: text('external_ref'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  companyIdx: index('products_company_idx').on(t.companyId),
  // UNIQUE(company_id, lower(name)) applied as expression index in SQL migration.
  companyIdUq: uniqueIndex('products_company_id_uq').on(t.companyId, t.id), // FK target
}));

// 4.9 stores — optional enrichment dimension.
export const stores = pgTable('stores', {
  id: uuid('id').primaryKey().defaultRandom(),
  companyId: uuid('company_id').notNull().references(() => companies.id),
  name: text('name').notNull(),
  externalRef: text('external_ref'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  companyIdx: index('stores_company_idx').on(t.companyId),
  companyIdUq: uniqueIndex('stores_company_id_uq').on(t.companyId, t.id), // FK target
}));

// 4.10 fx_rates — manual per-company FX catalog. Snapshot is copied onto each financial row.
export const fxRates = pgTable('fx_rates', {
  id: uuid('id').primaryKey().defaultRandom(),
  companyId: uuid('company_id').notNull().references(() => companies.id),
  baseCurrency: text('base_currency').$type<'GTQ' | 'USD'>().notNull(),
  quoteCurrency: text('quote_currency').$type<'GTQ' | 'USD'>().notNull(),
  rate: numeric('rate', { precision: 18, scale: 8 }).notNull(),
  effectiveDate: date('effective_date').notNull(),
  createdBy: uuid('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  uq: uniqueIndex('fx_rates_uq').on(t.companyId, t.baseCurrency, t.quoteCurrency, t.effectiveDate),
  lookupIdx: index('fx_rates_lookup_idx').on(t.companyId, t.quoteCurrency, t.effectiveDate),
}));
