import { pgTable, uuid, text, integer, numeric, date, jsonb, boolean, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { companies } from './companies';

// 4.22 reports — versioned executive reports (SQL metrics + AI narrative).
export const reports = pgTable('reports', {
  id: uuid('id').primaryKey().defaultRandom(),
  companyId: uuid('company_id').notNull().references(() => companies.id),
  periodStart: date('period_start').notNull(),
  periodEnd: date('period_end').notNull(),
  frequency: text('frequency').$type<'daily' | 'weekly'>().notNull(),
  currentVersionId: uuid('current_version_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  periodIdx: index('reports_company_period_idx').on(t.companyId, t.periodEnd),
}));

// 4.23 report_versions (APPEND-ONLY / immutable) — metrics jsonb + AI narrative + S3 render key.
export const reportVersions = pgTable('report_versions', {
  id: uuid('id').primaryKey().defaultRandom(),
  companyId: uuid('company_id').notNull(), // denormalized for scoping
  reportId: uuid('report_id').notNull().references(() => reports.id),
  version: integer('version').notNull(),
  metrics: jsonb('metrics').$type<Record<string, unknown>>().notNull(),
  narrative: text('narrative').notNull(),
  s3RenderKey: text('s3_render_key'),
  aiUsageEventId: uuid('ai_usage_event_id'),
  editedBy: uuid('edited_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  versionUq: uniqueIndex('report_versions_uq').on(t.reportId, t.version),
  reportIdx: index('report_versions_company_report_idx').on(t.companyId, t.reportId),
}));

// 4.24 alert_rules — fixed catalog, per-company thresholds. Deterministic (no AI).
export const alertRules = pgTable('alert_rules', {
  id: uuid('id').primaryKey().defaultRandom(),
  companyId: uuid('company_id').notNull().references(() => companies.id),
  ruleKey: text('rule_key').notNull(), // e.g. ar_overdue, margin_drop
  threshold: numeric('threshold', { precision: 18, scale: 4 }).notNull(),
  enabled: boolean('enabled').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  ruleUq: uniqueIndex('alert_rules_uq').on(t.companyId, t.ruleKey),
  enabledIdx: index('alert_rules_company_enabled_idx').on(t.companyId, t.enabled),
}));

// 4.25 alert_events — history of alert firings.
export const alertEvents = pgTable('alert_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  companyId: uuid('company_id').notNull().references(() => companies.id),
  alertRuleId: uuid('alert_rule_id').notNull().references(() => alertRules.id),
  triggeredValue: numeric('triggered_value', { precision: 18, scale: 4 }).notNull(),
  documentId: uuid('document_id'),
  notificationId: uuid('notification_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  createdIdx: index('alert_events_company_created_idx').on(t.companyId, t.createdAt),
  ruleIdx: index('alert_events_company_rule_idx').on(t.companyId, t.alertRuleId),
}));
