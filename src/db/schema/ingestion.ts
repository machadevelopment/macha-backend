import {
  pgTable, uuid, text, integer, bigint, jsonb, numeric, timestamp, index, uniqueIndex,
} from 'drizzle-orm/pg-core';
import { companies } from './companies';

// 4.13 industry_templates — global (NOT tenant-scoped) mapping templates by industry.
export const industryTemplates = pgTable('industry_templates', {
  id: uuid('id').primaryKey().defaultRandom(),
  industry: text('industry').notNull(),
  name: text('name').notNull(),
  currentVersionId: uuid('current_version_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  industryUq: uniqueIndex('industry_templates_industry_uq').on(t.industry),
}));

interface Synonyms { [canonical: string]: string[] }
interface FewShot { input: string; output: Record<string, unknown> }

// 4.14 industry_template_versions — immutable versioned template payloads (append-only).
export const industryTemplateVersions = pgTable('industry_template_versions', {
  id: uuid('id').primaryKey().defaultRandom(),
  templateId: uuid('template_id').notNull().references(() => industryTemplates.id),
  version: integer('version').notNull(),
  synonyms: jsonb('synonyms').$type<Synonyms>().notNull(),
  fewShot: jsonb('few_shot').$type<FewShot[]>().notNull(),
  createdBy: uuid('created_by').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  templateVersionUq: uniqueIndex('industry_template_versions_uq').on(t.templateId, t.version),
}));

// 4.11 documents — one row per uploaded Excel; orchestrates ingest + revert.
export const documents = pgTable('documents', {
  id: uuid('id').primaryKey().defaultRandom(),
  companyId: uuid('company_id').notNull().references(() => companies.id),
  uploadedBy: uuid('uploaded_by').notNull(),
  s3Key: text('s3_key').notNull(),
  originalFilename: text('original_filename').notNull(),
  fileSizeBytes: bigint('file_size_bytes', { mode: 'number' }).notNull(),
  mimeType: text('mime_type').notNull(),
  industryTemplateVersionId: uuid('industry_template_version_id').references(() => industryTemplateVersions.id),
  status: text('status')
    .$type<'queued' | 'processing' | 'review' | 'promoted' | 'reverted' | 'failed'>()
    .notNull().default('queued'),
  rowCount: integer('row_count'),
  flaggedCount: integer('flagged_count'),
  errorReason: text('error_reason'),
  promotedAt: timestamp('promoted_at', { withTimezone: true }),
  revertedAt: timestamp('reverted_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  statusIdx: index('documents_company_status_idx').on(t.companyId, t.status),
  createdIdx: index('documents_company_created_idx').on(t.companyId, t.createdAt),
}));

// 4.12 staging_rows — single staging area for AI-extracted rows before atomic promotion.
export const stagingRows = pgTable('staging_rows', {
  id: uuid('id').primaryKey().defaultRandom(),
  companyId: uuid('company_id').notNull().references(() => companies.id),
  documentId: uuid('document_id').notNull().references(() => documents.id),
  targetEntity: text('target_entity').$type<'transaction' | 'invoice' | 'bill'>().notNull(),
  payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
  confidence: numeric('confidence', { precision: 5, scale: 4 }),
  flagReason: text('flag_reason'),
  reviewStatus: text('review_status').$type<'pending' | 'clean' | 'approved' | 'rejected'>().notNull().default('pending'),
  reviewedBy: uuid('reviewed_by'),
  reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  docIdx: index('staging_rows_company_document_idx').on(t.companyId, t.documentId),
  reviewIdx: index('staging_rows_company_review_idx').on(t.companyId, t.reviewStatus),
  // Partial index WHERE flag_reason IS NOT NULL is applied in SQL migration.
}));
