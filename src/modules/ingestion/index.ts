import { Elysia, t } from 'elysia';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { tenantDerive } from '@/guards/tenant.derive';
import { assertClientCapability } from '@/guards/require-capability';
import { intakeConfig } from '@/config/intake';
import { uploadKey, uploadObject } from '@/lib/s3';
import { inspectXlsxWorkbook, estimateBatchCount } from '@/lib/xlsx-inspect';
import { getActiveCreditRule, getCreditBalance, estimateRequiredCredits } from '@/lib/credits';
import { documents, companies } from '@/db/schema';
import { enqueue, QUEUES } from '@/queue';

const ALLOWED_MIME_EXT: Record<string, string> = {
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.ms-excel': 'xls',
  'text/csv': 'csv',
};

// CU-868kfv972: rejection message must show the limit and the received value, in the
// company's locale. Backend has no i18n lib (that's a frontend concern per CLAUDE.md);
// this is intentionally a tiny, local dictionary scoped to intake errors only.
const MESSAGES = {
  es: {
    unsupportedType: (mime: string) =>
      `Tipo de archivo no soportado: ${mime}. Usa .xlsx, .xls o .csv.`,
    fileTooLarge: (limitMb: number, receivedMb: number) =>
      `El archivo supera el tamaño máximo permitido (${limitMb} MB). Recibido: ${receivedMb.toFixed(2)} MB.`,
    tooManySheets: (limit: number, received: number) =>
      `El libro supera el máximo de hojas permitidas (${limit}). Recibido: ${received}.`,
    tooManyRows: (limit: number, received: number) =>
      `El archivo supera el máximo de filas permitidas (${limit}). Recibido: ${received}.`,
    insufficientCredits: (required: number, balance: number) =>
      `Saldo de créditos insuficiente para procesar este archivo (requiere ~${required}, disponible: ${balance}).`,
  },
  en: {
    unsupportedType: (mime: string) => `Unsupported file type: ${mime}. Use .xlsx, .xls or .csv.`,
    fileTooLarge: (limitMb: number, receivedMb: number) =>
      `File exceeds the maximum allowed size (${limitMb} MB). Received: ${receivedMb.toFixed(2)} MB.`,
    tooManySheets: (limit: number, received: number) =>
      `Workbook exceeds the maximum allowed sheets (${limit}). Received: ${received}.`,
    tooManyRows: (limit: number, received: number) =>
      `File exceeds the maximum allowed rows (${limit}). Received: ${received}.`,
    insufficientCredits: (required: number, balance: number) =>
      `Insufficient credit balance to process this file (requires ~${required}, available: ${balance}).`,
  },
} as const;

export const ingestion = new Elysia({ prefix: '/documents' }).use(tenantDerive).post(
  '/',
  async ({ body, companyId, userId, role, set, db }) => {
    assertClientCapability(role, 'upload_excel', set);

    const [company] = await db
      .select({ locale: companies.locale })
      .from(companies)
      .where(eq(companies.id, companyId));
    const msg = MESSAGES[company?.locale ?? 'es'];

    const file = body.file;
    const mime = file.type;
    const ext = ALLOWED_MIME_EXT[mime];

    // Hard rejection at receipt, BEFORE queueing a job or persisting to S3 — none of
    // the checks below touch S3/documents until every cap passes.
    if (!ext) {
      set.status = 415;
      return { error: msg.unsupportedType(mime) };
    }

    const sizeMb = file.size / (1024 * 1024);
    if (sizeMb > intakeConfig.maxFileSizeMb) {
      set.status = 413;
      return { error: msg.fileTooLarge(intakeConfig.maxFileSizeMb, sizeMb) };
    }

    const buffer = new Uint8Array(await file.arrayBuffer());

    // Cheap pre-check (no full parse) — only meaningful for .xlsx (OOXML zip); .xls
    // (legacy binary) and .csv fall back to the size cap above only, see xlsx-inspect.ts.
    // Also used below to estimate the credit hard-block (CU-868kfvaa6) — the `excel`
    // rule is billed per batch, so we need an upfront batch-count guess.
    let estimatedBatches = 1;
    if (ext === 'xlsx') {
      const { sheetRowCounts } = inspectXlsxWorkbook(buffer);

      if (sheetRowCounts.length > intakeConfig.maxSheetsPerWorkbook) {
        set.status = 413;
        return {
          error: msg.tooManySheets(intakeConfig.maxSheetsPerWorkbook, sheetRowCounts.length),
        };
      }

      const totalRows = sheetRowCounts.reduce((a, b) => a + b, 0);
      if (totalRows > intakeConfig.maxRowsPerFile) {
        set.status = 413;
        return { error: msg.tooManyRows(intakeConfig.maxRowsPerFile, totalRows) };
      }

      estimatedBatches = estimateBatchCount(
        sheetRowCounts,
        intakeConfig.largeSheetRowThreshold,
        intakeConfig.batchSize,
      );
    }

    // Hard block on insufficient credits (CU-868kfvaa6, CU-868kfv97x): verify BEFORE
    // enqueueing the AI job — no call, no consumption row, if the balance is short.
    // No active rule for `excel` (v1 default, see scripts/seed.ts) means no cap.
    const creditRule = await getActiveCreditRule(db, 'excel');
    if (creditRule) {
      const requiredCredits = estimateRequiredCredits(creditRule, estimatedBatches);
      const balance = await getCreditBalance(db, companyId);
      if (balance < requiredCredits) {
        set.status = 402;
        return { error: msg.insufficientCredits(requiredCredits, balance) };
      }
    }

    // All caps passed — now (and only now) persist original + create documents row.
    const documentId = randomUUID();
    const s3Key = uploadKey(companyId, documentId, ext);
    await uploadObject(s3Key, buffer, mime);

    const [doc] = await db
      .insert(documents)
      .values({
        id: documentId,
        companyId,
        uploadedBy: userId,
        s3Key,
        originalFilename: file.name,
        fileSizeBytes: file.size,
        mimeType: mime,
        status: 'queued',
      })
      .returning();

    await enqueue(QUEUES.excelIngest, { documentId, companyId });

    set.status = 202;
    return { documentId: doc!.id, status: doc!.status };
  },
  {
    body: t.Object({
      // Outer bound only (well above the real cap) so obviously-abusive uploads never
      // reach the handler; the precise, locale-aware rejection happens inside it.
      file: t.File({ maxSize: '50m' }),
    }),
  },
);
