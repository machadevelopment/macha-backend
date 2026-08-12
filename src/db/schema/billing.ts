import {
  pgTable,
  uuid,
  text,
  integer,
  boolean,
  timestamp,
  uniqueIndex,
  index,
} from 'drizzle-orm/pg-core';
import { companies } from './companies';

/**
 * Catálogo de planes (ticket B3, ronda de QA 2026-08-11). Migración `0021_plans_catalog`.
 *
 * Antes no existía: `subscriptions.plan_code` era texto libre con default `'base'`, y el
 * único valor que se escribía era ese literal, hardcodeado en `billing/register.ts`. No
 * había dónde estuviera escrito qué planes existen ni cuánto trae cada uno, así que
 * "cambiar de plan" no era una operación posible — no hay a qué cambiarse.
 *
 * `code` es la PK y no un uuid: es la llave natural, la que ya vive en
 * `subscriptions.plan_code` y la que un operador lee. Un uuid habría obligado a un join
 * para responder "¿en qué plan está esta empresa?" y a migrar el valor existente.
 *
 * NO es un ledger append-only — es catálogo, y el `super_admin` lo edita desde el panel.
 * La baja es LÓGICA (`active = false`) y nunca un DELETE: una empresa puede seguir suscrita
 * a un plan retirado, y borrar la fila rompería la FK de `subscriptions`.
 */
export const plans = pgTable(
  'plans',
  {
    code: text('code').primaryKey(),
    name: text('name').notNull(),
    amountUsdCents: integer('amount_usd_cents').notNull(),
    /**
     * Créditos que trae el plan. Entero porque un crédito es la unidad que el cliente ve
     * y cuenta; el dinero de la plataforma se mide en `cost_usd` (numeric) del lado de
     * `ai_usage_events`, que es otra cosa.
     */
    monthlyCredits: integer('monthly_credits').notNull(),
    /** Orden de presentación: sin esto la comparación en pantalla no se lee como escalera. */
    sortOrder: integer('sort_order').notNull().default(0),
    active: boolean('active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    activeSortIdx: index('plans_active_sort_idx').on(t.active, t.sortOrder),
  }),
);

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
    // FK a `plans.code` desde la migración 0021: ya no es texto libre. Un typo en el
    // código de plan deja de ser una suscripción silenciosamente rota que solo se
    // descubre cuando alguien mira la factura.
    planCode: text('plan_code')
      .notNull()
      .default('base')
      .references(() => plans.code),
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
