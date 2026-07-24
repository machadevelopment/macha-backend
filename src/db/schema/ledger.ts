import {
  pgTable, uuid, text, numeric, date, timestamp, index, primaryKey, foreignKey,
} from 'drizzle-orm/pg-core';
import { companies } from './companies';
import { products, stores } from './dimensions';

/**
 * PARTITIONED tables (transactions, invoices, bills): PARTITION BY LIST (company_id).
 * Composite PK (company_id, id). drizzle-kit does NOT emit CREATE ... PARTITION OF,
 * RLS, partial indexes or REVOKE UPDATE,DELETE — those live in raw SQL migrations,
 * and per-tenant partitions are created at company provisioning (not a global migration).
 */

// 4.5 transactions — main financial ledger (highest volume).
export const transactions = pgTable('transactions', {
  id: uuid('id').notNull().defaultRandom(),
  companyId: uuid('company_id').notNull(),
  documentId: uuid('document_id').notNull(),
  date: date('date').notNull(),
  type: text('type').$type<'revenue' | 'cogs' | 'opex' | 'other'>().notNull(),
  category: text('category').notNull(),
  description: text('description'),
  originalAmount: numeric('original_amount', { precision: 18, scale: 2 }).notNull(),
  originalCurrency: text('original_currency').$type<'GTQ' | 'USD'>().notNull(),
  amountBase: numeric('amount_base', { precision: 18, scale: 2 }).notNull(),
  fxRate: numeric('fx_rate', { precision: 18, scale: 8 }).notNull(),
  fxRateDate: date('fx_rate_date').notNull(),
  productId: uuid('product_id'),
  storeId: uuid('store_id'),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  pk: primaryKey({ columns: [t.companyId, t.id] }),
  companyFk: foreignKey({ columns: [t.companyId], foreignColumns: [companies.id] }),
  // Cross-tenant FKs are composite (include company_id) so cross-tenant refs are impossible.
  productFk: foreignKey({ columns: [t.companyId, t.productId], foreignColumns: [products.companyId, products.id] }),
  storeFk: foreignKey({ columns: [t.companyId, t.storeId], foreignColumns: [stores.companyId, stores.id] }),
  dateIdx: index('transactions_company_date_idx').on(t.companyId, t.date),
  typeCatIdx: index('transactions_company_type_cat_date_idx').on(t.companyId, t.type, t.category, t.date),
  docIdx: index('transactions_company_document_idx').on(t.companyId, t.documentId),
}));

// 4.6 invoices — accounts receivable (AR).
export const invoices = pgTable('invoices', {
  id: uuid('id').notNull().defaultRandom(),
  companyId: uuid('company_id').notNull(),
  documentId: uuid('document_id').notNull(),
  counterparty: text('counterparty').notNull(),
  issueDate: date('issue_date').notNull(),
  dueDate: date('due_date'),
  originalAmount: numeric('original_amount', { precision: 18, scale: 2 }).notNull(),
  originalCurrency: text('original_currency').$type<'GTQ' | 'USD'>().notNull(),
  amountBase: numeric('amount_base', { precision: 18, scale: 2 }).notNull(),
  fxRate: numeric('fx_rate', { precision: 18, scale: 8 }).notNull(),
  fxRateDate: date('fx_rate_date').notNull(),
  status: text('status').$type<'open' | 'paid'>().notNull().default('open'),
  settledTransactionId: uuid('settled_transaction_id'),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  pk: primaryKey({ columns: [t.companyId, t.id] }),
  companyFk: foreignKey({ columns: [t.companyId], foreignColumns: [companies.id] }),
  settledFk: foreignKey({ columns: [t.companyId, t.settledTransactionId], foreignColumns: [transactions.companyId, transactions.id] }),
  statusDueIdx: index('invoices_company_status_due_idx').on(t.companyId, t.status, t.dueDate),
  docIdx: index('invoices_company_document_idx').on(t.companyId, t.documentId),
}));

// 4.7 bills — accounts payable (AP). Same shape as invoices, inverse semantics.
export const bills = pgTable('bills', {
  id: uuid('id').notNull().defaultRandom(),
  companyId: uuid('company_id').notNull(),
  documentId: uuid('document_id').notNull(),
  counterparty: text('counterparty').notNull(),
  issueDate: date('issue_date').notNull(),
  dueDate: date('due_date'),
  originalAmount: numeric('original_amount', { precision: 18, scale: 2 }).notNull(),
  originalCurrency: text('original_currency').$type<'GTQ' | 'USD'>().notNull(),
  amountBase: numeric('amount_base', { precision: 18, scale: 2 }).notNull(),
  fxRate: numeric('fx_rate', { precision: 18, scale: 8 }).notNull(),
  fxRateDate: date('fx_rate_date').notNull(),
  status: text('status').$type<'open' | 'paid'>().notNull().default('open'),
  settledTransactionId: uuid('settled_transaction_id'),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  pk: primaryKey({ columns: [t.companyId, t.id] }),
  companyFk: foreignKey({ columns: [t.companyId], foreignColumns: [companies.id] }),
  settledFk: foreignKey({ columns: [t.companyId, t.settledTransactionId], foreignColumns: [transactions.companyId, transactions.id] }),
  statusDueIdx: index('bills_company_status_due_idx').on(t.companyId, t.status, t.dueDate),
  docIdx: index('bills_company_document_idx').on(t.companyId, t.documentId),
}));
