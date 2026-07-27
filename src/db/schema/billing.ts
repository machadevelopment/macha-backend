import { pgTable, uuid, text, integer, timestamp, uniqueIndex, index } from 'drizzle-orm/pg-core';
import { companies } from './companies';

// CU-868kfvae6/868kfvaed/868kfvaem: no existía tabla propia (ni en data model.md ni
// en el PRD) — diseño nuevo para esta épica. `status` usa exactamente los valores
// reales de la API de Recurrente (docs.recurrente.com/referencia-api,
// GET /subscriptions/:id): active/paused/past_due/cancelled, más
// 'pending_checkout' propio (antes de que el checkout se complete).
export const subscriptions = pgTable(
  'subscriptions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id),
    providerName: text('provider_name').$type<'recurrente'>().notNull().default('recurrente'),
    providerSubscriptionId: text('provider_subscription_id'), // null until checkout completes
    providerCheckoutId: text('provider_checkout_id'),
    planCode: text('plan_code').notNull().default('base'),
    amountUsdCents: integer('amount_usd_cents').notNull(),
    status: text('status')
      .$type<'pending_checkout' | 'active' | 'paused' | 'past_due' | 'cancelled'>()
      .notNull()
      .default('pending_checkout'),
    currentPeriodStart: timestamp('current_period_start', { withTimezone: true }),
    currentPeriodEnd: timestamp('current_period_end', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    companyIdx: index('subscriptions_company_idx').on(t.companyId),
    providerSubUq: uniqueIndex('subscriptions_provider_sub_uq').on(t.providerSubscriptionId),
  }),
);

// APPEND-ONLY (like credit_transactions/ai_usage_events) — a payment is a fact that
// happened, corrections are compensating rows, never UPDATE/DELETE.
export const payments = pgTable(
  'payments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id),
    subscriptionId: uuid('subscription_id'), // null for one-off credit top-ups
    kind: text('kind').$type<'subscription_charge' | 'credit_topup'>().notNull(),
    // CU-868kfvaed criterio 1 (no negociable): idempotencia por id de evento del
    // webhook (Recurrente/svix "id" header, estable entre reintentos de entrega) —
    // UNIQUE a nivel de columna, no un chequeo a nivel de app (el chequeo previo
    // tiene condición de carrera bajo reintentos concurrentes; el constraint no).
    providerEventId: text('provider_event_id').notNull(),
    providerPaymentId: text('provider_payment_id'),
    status: text('status').$type<'succeeded' | 'failed' | 'pending'>().notNull(),
    amountUsdCents: integer('amount_usd_cents').notNull(),
    creditsGranted: integer('credits_granted'), // only for kind='credit_topup'
    failureReason: text('failure_reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    companyIdx: index('payments_company_created_idx').on(t.companyId, t.createdAt),
    eventUq: uniqueIndex('payments_provider_event_uq').on(t.providerEventId),
  }),
);
