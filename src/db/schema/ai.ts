import { pgTable, uuid, text, integer, numeric, timestamp, index } from 'drizzle-orm/pg-core';
import { companies } from './companies';
import { users } from './identity';

// 4.19 ai_usage_events (APPEND-ONLY) — one row per Claude call. No prompts/financial data (ZDR).
export const aiUsageEvents = pgTable(
  'ai_usage_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id),
    kind: text('kind')
      .$type<'excel' | 'chat' | 'insight' | 'report_generation' | 'excel_correction'>()
      .notNull(),
    refId: uuid('ref_id'),
    model: text('model').notNull(),
    inputTokens: integer('input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    costUsd: numeric('cost_usd', { precision: 12, scale: 6 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    createdIdx: index('ai_usage_events_company_created_idx').on(t.companyId, t.createdAt),
    kindIdx: index('ai_usage_events_company_kind_created_idx').on(t.companyId, t.kind, t.createdAt),
  }),
);

// 4.20 credit_transactions (APPEND-ONLY) — insight credit ledger; balance = SUM(delta).
export const creditTransactions = pgTable(
  'credit_transactions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id),
    delta: integer('delta').notNull(), // +allotment/top_up, -insight_consumption
    reason: text('reason')
      .$type<'monthly_allotment' | 'top_up' | 'insight_consumption'>()
      .notNull(),
    refId: uuid('ref_id'), // insight_requests.id on consumption
    createdBy: uuid('created_by'), // staff.id on manual top-ups
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    createdIdx: index('credit_transactions_company_created_idx').on(t.companyId, t.createdAt),
  }),
);

// 4.21 insight_requests — snapshot of insight prompt at request time (frozen).
export const insightRequests = pgTable(
  'insight_requests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id),
    requestedBy: uuid('requested_by')
      .notNull()
      .references(() => users.id),
    promptSnapshot: text('prompt_snapshot').notNull(),
    result: text('result'),
    aiUsageEventId: uuid('ai_usage_event_id'),
    creditTransactionId: uuid('credit_transaction_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    createdIdx: index('insight_requests_company_created_idx').on(t.companyId, t.createdAt),
  }),
);
