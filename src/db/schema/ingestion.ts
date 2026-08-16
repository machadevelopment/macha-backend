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

/**
 * Perfil de mapeo de columnas POR EMPRESA — el override de `industry_templates`
 * (migración `0027`, CU-868krmrcj · ARCHITECTURE 6.3.11 y 6.3.12).
 *
 * El molde por industria es demasiado grueso para la contabilidad de una PYME, que trae
 * encabezados propios. Visto en producción: una empresa con `industry="candelas"` corriendo
 * con la plantilla genérica porque su industria no tiene una, sin forma de que el sistema
 * aprenda cómo son SUS archivos.
 *
 * CONVIVE con la plantilla global, no la reemplaza: esta tabla no toca `industryTemplates`
 * ni sus versiones. Si el perfil no aplica, la plantilla sigue siendo el molde.
 *
 * APPEND-ONLY Y VERSIONADO, y no por simetría con los demás ledgers: un mapa de columnas
 * equivocado desplaza toda la contabilidad de una hoja a la columna de al lado, con datos
 * plausibles y sin un solo error. Cuando eso pase, la única pregunta útil es "¿con qué mapa
 * se leyó la carga del martes?", y solo se contesta si las versiones viejas siguen ahí. El
 * rol `macha_app` no tiene UPDATE ni DELETE sobre esta tabla.
 *
 * La vigente es la de mayor `version` para el par (empresa, `headerHash`).
 */
export const companyColumnProfiles = pgTable(
  'company_column_profiles',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id),
    /** sha256 hex de los encabezados normalizados y EN ORDEN — ver `lib/header-hash.ts`. */
    headerHash: text('header_hash').notNull(),
    /**
     * Los encabezados normalizados que produjeron el hash. Redundante a propósito: el hash
     * dice si el layout es el mismo pero no se puede leer, y esto es lo único que permite
     * diagnosticar por qué un perfil dejó de calzar sin adivinar.
     */
    headers: jsonb('headers').notNull(),
    /** Informativo, NO parte de la identidad: "Ventas" y "Ventas 2026" son el mismo layout. */
    sheetName: text('sheet_name'),
    /** El `ColumnMap` de `lib/row-assembly.ts`. */
    columnMap: jsonb('column_map').notNull(),
    /** `inferido` | `confirmado_por_cliente` | `corregido_por_staff`. */
    source: text('source').notNull().default('inferido'),
    version: integer('version').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    /** `null` = lo infirió la ingesta sola, sin persona de por medio. */
    createdBy: uuid('created_by'),
  },
  (t) => ({
    // El árbitro real contra dos versiones con el mismo número: dos cargas simultáneas de la
    // misma empresa pueden calcular `max(version) + 1` a la vez. Acá la segunda falla.
    versionUq: uniqueIndex('company_column_profiles_version_uq').on(
      t.companyId,
      t.headerHash,
      t.version,
    ),
    vigenteIdx: index('company_column_profiles_vigente_idx').on(
      t.companyId,
      t.headerHash,
      t.version,
    ),
  }),
);
