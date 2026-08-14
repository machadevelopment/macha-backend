import {
  pgTable,
  uuid,
  text,
  integer,
  bigint,
  jsonb,
  numeric,
  timestamp,
  index,
  uniqueIndex,
  primaryKey,
} from 'drizzle-orm/pg-core';
import { companies } from './companies';

// 4.13 industry_templates — global (NOT tenant-scoped) mapping templates by industry.
export const industryTemplates = pgTable(
  'industry_templates',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    industry: text('industry').notNull(),
    name: text('name').notNull(),
    currentVersionId: uuid('current_version_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    industryUq: uniqueIndex('industry_templates_industry_uq').on(t.industry),
  }),
);

interface Synonyms {
  [canonical: string]: string[];
}
interface FewShot {
  input: string;
  output: Record<string, unknown>;
}

// 4.14 industry_template_versions — immutable versioned template payloads (append-only).
export const industryTemplateVersions = pgTable(
  'industry_template_versions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    templateId: uuid('template_id')
      .notNull()
      .references(() => industryTemplates.id),
    version: integer('version').notNull(),
    synonyms: jsonb('synonyms').$type<Synonyms>().notNull(),
    fewShot: jsonb('few_shot').$type<FewShot[]>().notNull(),
    createdBy: uuid('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    templateVersionUq: uniqueIndex('industry_template_versions_uq').on(t.templateId, t.version),
  }),
);

// 4.11 documents — one row per uploaded Excel; orchestrates ingest + revert.
export const documents = pgTable(
  'documents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id),
    uploadedBy: uuid('uploaded_by').notNull(),
    s3Key: text('s3_key').notNull(),
    originalFilename: text('original_filename').notNull(),
    fileSizeBytes: bigint('file_size_bytes', { mode: 'number' }).notNull(),
    mimeType: text('mime_type').notNull(),
    industryTemplateVersionId: uuid('industry_template_version_id').references(
      () => industryTemplateVersions.id,
    ),
    status: text('status')
      // `unsupported` (migración 0018): terminal, el archivo no se pudo leer y
      // reintentarlo da lo mismo — distinto de `failed`, que sí es reintentable.
      .$type<
        | 'queued'
        | 'processing'
        | 'review'
        | 'promoted'
        | 'reverted'
        | 'failed'
        | 'unsupported'
        // El CLIENTE paró la carga (migración 0026). Terminal, y deliberadamente distinto de
        // `failed`: una carga que el usuario decidió parar no salió mal.
        | 'cancelled'
      >()
      .notNull()
      .default('queued'),
    rowCount: integer('row_count'),
    flaggedCount: integer('flagged_count'),
    errorReason: text('error_reason'),
    promotedAt: timestamp('promoted_at', { withTimezone: true }),
    revertedAt: timestamp('reverted_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    statusIdx: index('documents_company_status_idx').on(t.companyId, t.status),
    createdIdx: index('documents_company_created_idx').on(t.companyId, t.createdAt),
  }),
);

// 4.12 staging_rows — single staging area for AI-extracted rows before atomic promotion.
export const stagingRows = pgTable(
  'staging_rows',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id),
    documentId: uuid('document_id')
      .notNull()
      .references(() => documents.id),
    targetEntity: text('target_entity').$type<'transaction' | 'invoice' | 'bill'>().notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    confidence: numeric('confidence', { precision: 5, scale: 4 }),
    flagReason: text('flag_reason'),
    reviewStatus: text('review_status')
      .$type<'pending' | 'clean' | 'approved' | 'rejected'>()
      .notNull()
      .default('pending'),
    reviewedBy: uuid('reviewed_by'),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
    /**
     * Migración 0020: instante en que esta fila se insertó en
     * `transactions`/`invoices`/`bills`. `null` = todavía no.
     *
     * Es la protección POR FILA contra doble inserción, y lo que hace posible promover un
     * documento en varias pasadas: primero sus filas limpias, después las que staff
     * resuelva. El cerrojo anterior era por documento (`documents.status <> 'promoted'`) y
     * con promoción parcial habría impedido justamente la segunda pasada legítima.
     */
    promotedAt: timestamp('promoted_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    docIdx: index('staging_rows_company_document_idx').on(t.companyId, t.documentId),
    reviewIdx: index('staging_rows_company_review_idx').on(t.companyId, t.reviewStatus),
    // Partial indexes (WHERE flag_reason IS NOT NULL, WHERE promoted_at IS NULL) are
    // applied in SQL migrations — drizzle-kit doesn't generate them.
  }),
);

/**
 * 4.12a document_ingest_batches — marca de progreso del worker de ingesta (CU-868kkgypv).
 *
 * POR QUÉ EXISTE. `excel.ingest` se reintenta hasta 3 veces (src/queue/index.ts) y el
 * worker relanzaba todo el trabajo desde la primera hoja. Como cada lote confirma su
 * propia transacción corta —deliberado: entre lotes hay red lenta y no se debe retener
 * una conexión del pool durante minutos— los lotes ya hechos sobrevivían al fallo del
 * siguiente. Un fallo en la hoja 3 de 4 dejaba, al reintentar, `staging_rows`
 * duplicadas (y por tanto transacciones/facturas dobles al promover), créditos cobrados
 * dos veces sobre un ledger append-only que no se puede corregir sin compensación, y
 * `cost_usd` inflado — el dato con el que Macha va a fijar el precio de los créditos.
 *
 * LA UNIDAD DE PROGRESO ES EL LOTE (hoja + índice), no la fila ni el documento:
 *   - la fila no sirve como clave: Claude puede devolver más o menos filas que las de
 *     entrada, así que no hay correspondencia estable posición-a-posición;
 *   - el documento es demasiado grueso: reintentar por documento vuelve a gastar todas
 *     las llamadas a Claude ya pagadas.
 * El lote es exactamente la unidad que consume una llamada a Claude, que es lo que se
 * quiere no repetir.
 *
 * La fila se inserta EN LA MISMA TRANSACCIÓN que las `staging_rows`, el débito de
 * créditos y el `ai_usage_events` del lote. Esa atomicidad es lo que hace la marca
 * fiable: si la transacción falla, no queda ni marca ni efectos, y el reintento rehace
 * el lote entero; si confirma, el reintento lo salta sin llamar a Claude.
 */
export const documentIngestBatches = pgTable(
  'document_ingest_batches',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id),
    documentId: uuid('document_id')
      .notNull()
      .references(() => documents.id),
    sheetName: text('sheet_name').notNull(),
    batchIndex: integer('batch_index').notNull(),
    /** Filas de ENTRADA del lote — lo que suma `documents.row_count` al reanudar. */
    rowCount: integer('row_count').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // El árbitro real de la idempotencia, no un "if not exists" en la app.
    batchUq: uniqueIndex('document_ingest_batches_uq').on(
      t.companyId,
      t.documentId,
      t.sheetName,
      t.batchIndex,
    ),
  }),
);

/**
 * Huellas de filas ya ingeridas — deduplicación ANTES de llamar a la IA (migración `0023`).
 *
 * El caso que resuelve: un cliente exporta su contabilidad COMPLETA y la sube cada semana.
 * Sin esta tabla, las 5.000 filas de la semana pasada vuelven a Claude y se pagan otra vez.
 * Con el 95,7 % del costo del recibo en tokens de salida (medido 2026-08-12), cada fila
 * reprocesada es dinero tirado.
 *
 * No la cubría nada de lo que ya existía: `documentIngestBatches` protege contra reprocesar
 * el mismo DOCUMENTO y `stagingRows.promotedAt` contra promover la misma FILA DE STAGING.
 * Ninguna protege contra un documento nuevo con filas viejas.
 *
 * `fingerprint` sale de `lib/row-fingerprint.ts`, que documenta por qué incluye un ordinal
 * de aparición: dos ventas iguales el mismo día NO son un duplicado.
 *
 * SIN DELETE en el rol de la app (ver la migración): revertir una carga no borra huellas. Si
 * las borrara, resubir el archivo revertido lo reprocesaría entero.
 */
export const ingestedRows = pgTable(
  'ingested_rows',
  {
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id),
    fingerprint: text('fingerprint').notNull(),
    /** Trazabilidad, no identidad: la huella NO depende del documento. */
    firstSeenDocumentId: uuid('first_seen_document_id')
      .notNull()
      .references(() => documents.id),
    sheetName: text('sheet_name').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.companyId, t.fingerprint] }),
  }),
);
