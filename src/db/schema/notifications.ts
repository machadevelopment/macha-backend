import { pgTable, uuid, text, timestamp, index } from 'drizzle-orm/pg-core';
import { companies } from './companies';

// 4.26 notifications — email sends (report/alert) via Resend + delivery status.
export const notifications = pgTable('notifications', {
  id: uuid('id').primaryKey().defaultRandom(),
  companyId: uuid('company_id').notNull().references(() => companies.id),
  kind: text('kind').$type<'report' | 'alert'>().notNull(),
  recipientEmail: text('recipient_email').notNull(),
  refId: uuid('ref_id'), // report_version_id or alert_event_id
  resendMessageId: text('resend_message_id'),
  status: text('status').$type<'queued' | 'sent' | 'delivered' | 'bounced' | 'failed'>().notNull().default('queued'),
  errorReason: text('error_reason'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  createdIdx: index('notifications_company_created_idx').on(t.companyId, t.createdAt),
  resendIdx: index('notifications_resend_idx').on(t.resendMessageId), // webhook correlation
}));
