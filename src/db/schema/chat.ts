import { pgTable, uuid, text, integer, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { companies } from './companies';
import { users } from './identity';

// 4.16 chats — named CFO assistant thread per (company_id, user_id).
export const chats = pgTable(
  'chats',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    title: text('title').notNull().default('Nuevo chat'),
    reportVersionId: uuid('report_version_id'), // deep-link origin (US-14)
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    threadIdx: index('chats_company_user_updated_idx').on(t.companyId, t.userId, t.updatedAt),
  }),
);

// 4.17 chat_messages — messages within a thread (user/assistant/tool).
export const chatMessages = pgTable(
  'chat_messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id').notNull(), // denormalized for scoping/index
    chatId: uuid('chat_id')
      .notNull()
      .references(() => chats.id),
    segmentId: uuid('segment_id'),
    role: text('role').$type<'user' | 'assistant' | 'tool'>().notNull(),
    content: text('content').notNull(),
    aiUsageEventId: uuid('ai_usage_event_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    threadIdx: index('chat_messages_company_chat_created_idx').on(
      t.companyId,
      t.chatId,
      t.createdAt,
    ),
  }),
);

// 4.18 chat_segments — long-conversation segmentation w/ AI handoff doc (invisible to user).
export const chatSegments = pgTable(
  'chat_segments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id),
    chatId: uuid('chat_id')
      .notNull()
      .references(() => chats.id),
    seq: integer('seq').notNull(),
    handoffDoc: text('handoff_doc'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    seqUq: uniqueIndex('chat_segments_uq').on(t.companyId, t.chatId, t.seq),
  }),
);
