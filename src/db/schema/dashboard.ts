import { pgTable, uuid, text, numeric, date, timestamp, uniqueIndex, index } from 'drizzle-orm/pg-core';
import { companies } from './companies';

// 4.15 metric_rollups — cache-aside dashboard aggregates. Reconstructible from the ledger.
export const metricRollups = pgTable('metric_rollups', {
  id: uuid('id').primaryKey().defaultRandom(),
  companyId: uuid('company_id').notNull().references(() => companies.id),
  granularity: text('granularity').$type<'month' | 'quarter' | 'year'>().notNull(),
  period: date('period').notNull(),
  type: text('type').$type<'revenue' | 'cogs' | 'opex' | 'other' | null>(),
  category: text('category'),
  amountBase: numeric('amount_base', { precision: 18, scale: 2 }).notNull(),
  computedAt: timestamp('computed_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  uq: uniqueIndex('metric_rollups_uq').on(t.companyId, t.granularity, t.period, t.type, t.category),
  periodIdx: index('metric_rollups_company_period_idx').on(t.companyId, t.granularity, t.period),
}));
