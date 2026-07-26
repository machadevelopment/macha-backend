import {
  pgTable,
  uuid,
  text,
  integer,
  numeric,
  boolean,
  timestamp,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
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
    // CU-868kfv97x: unidades facturables procesadas en la llamada (filas/hojas/
    // mensajes/reportes según `kind`) — necesario para tarifar reglas `variable` del
    // motor de créditos (creditRules) más adelante. Inferido por el agente: el campo
    // exacto que pidió Jose no llegó completo por un bug de ClickUp; confirmar nombre.
    billableUnits: integer('billable_units'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    createdIdx: index('ai_usage_events_company_created_idx').on(t.companyId, t.createdAt),
    kindIdx: index('ai_usage_events_company_kind_created_idx').on(t.companyId, t.kind, t.createdAt),
  }),
);

// 4.19a credit_rules — versioned, admin-configurable pricing engine (CU-868kfv97x,
// decision by Jose: build the flexible mechanism now, defer the actual numbers.
// Global config (curated by super_admin), not tenant-scoped — mirrors industry_templates.
// Rule types: 'fixed' (N credits/execution) or 'variable' (N credits/unit processed,
// see ai_usage_events.billable_units). Only the latest `active` version per action
// applies; history is kept for audit (never deleted, new version instead).
export const creditRules = pgTable(
  'credit_rules',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    actionKind: text('action_kind')
      .$type<'excel' | 'chat' | 'insight' | 'report_generation'>()
      .notNull(),
    ruleType: text('rule_type').$type<'fixed' | 'variable'>().notNull(),
    creditsPerUnit: numeric('credits_per_unit', { precision: 10, scale: 4 }).notNull(),
    unit: text('unit').$type<'execution' | 'batch' | 'sheet' | 'row'>(), // null when rule_type='fixed'
    version: integer('version').notNull(),
    active: boolean('active').notNull().default(true),
    createdBy: uuid('created_by'), // staff.id
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    versionUq: uniqueIndex('credit_rules_action_version_uq').on(t.actionKind, t.version),
  }),
);

// 4.20 credit_transactions (APPEND-ONLY) — credit ledger; balance = SUM(delta).
// Generalized in CU-868kfv97x: `delta` already is "a quantity, not an event" (Jose's
// requirement); actionKind + creditRuleId record WHICH action and rule version applied
// a consumption, without changing the append-only/quantity semantics. v1 SCOPE UNCHANGED
// (PRD/CLAUDE.md): only `insight` actually debits — see scripts/seed.ts, only the
// insight rule ships `active`.
export const creditTransactions = pgTable(
  'credit_transactions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id),
    delta: integer('delta').notNull(), // +allotment/top_up, -consumption
    reason: text('reason').$type<'monthly_allotment' | 'top_up' | 'consumption'>().notNull(),
    actionKind: text('action_kind').$type<'excel' | 'chat' | 'insight' | 'report_generation'>(), // set only when reason='consumption'
    creditRuleId: uuid('credit_rule_id').references(() => creditRules.id), // frozen rule version applied
    refId: uuid('ref_id'), // origin object: document_id/chat_id/report_id/insight_requests.id
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
