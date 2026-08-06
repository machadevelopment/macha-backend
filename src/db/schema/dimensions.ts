import {
  pgTable,
  uuid,
  text,
  numeric,
  date,
  timestamp,
  uniqueIndex,
  index,
} from 'drizzle-orm/pg-core';
import { companies } from './companies';

// 4.8 products — optional enrichment dimension. Referenced via composite (company_id,id) FK.
export const products = pgTable(
  'products',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id),
    name: text('name').notNull(),
    /**
     * Agrupador libre para "ventas por categoría" (pantalla Ventas por producto).
     *
     * Nullable a propósito: un producto existe desde que la ingesta lo nombra, y en ese
     * momento puede no haber nada en la fila del Excel que diga a qué familia pertenece.
     * Un default tipo 'sin categoría' se vería idéntico a una categoría real en la
     * gráfica de participación; el null deja que la UI diga "sin clasificar", que es
     * distinto.
     *
     * Es texto libre y no una tabla `product_categories` como en el prototipo: la
     * categoría de producto es una etiqueta que sale de la IA leyendo el Excel del
     * cliente, igual que `transactions.category`, y una tabla aparte solo agregaría un
     * catálogo que nadie administra todavía. Si más adelante hace falta renombrar
     * categorías en masa, ahí se justifica promoverla a dimensión propia.
     */
    category: text('category'),
    externalRef: text('external_ref'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    companyIdx: index('products_company_idx').on(t.companyId),
    // UNIQUE(company_id, lower(name)) applied as expression index in SQL migration.
    companyIdUq: uniqueIndex('products_company_id_uq').on(t.companyId, t.id), // FK target
    categoryIdx: index('products_company_category_idx').on(t.companyId, t.category),
  }),
);

// 4.9 stores — optional enrichment dimension.
export const stores = pgTable(
  'stores',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id),
    name: text('name').notNull(),
    externalRef: text('external_ref'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    companyIdx: index('stores_company_idx').on(t.companyId),
    companyIdUq: uniqueIndex('stores_company_id_uq').on(t.companyId, t.id), // FK target
  }),
);

// 4.10 fx_rates — manual per-company FX catalog. Snapshot is copied onto each financial row.
export const fxRates = pgTable(
  'fx_rates',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id),
    baseCurrency: text('base_currency').$type<'GTQ' | 'USD'>().notNull(),
    quoteCurrency: text('quote_currency').$type<'GTQ' | 'USD'>().notNull(),
    rate: numeric('rate', { precision: 18, scale: 8 }).notNull(),
    effectiveDate: date('effective_date').notNull(),
    createdBy: uuid('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uq: uniqueIndex('fx_rates_uq').on(
      t.companyId,
      t.baseCurrency,
      t.quoteCurrency,
      t.effectiveDate,
    ),
    lookupIdx: index('fx_rates_lookup_idx').on(t.companyId, t.quoteCurrency, t.effectiveDate),
  }),
);
