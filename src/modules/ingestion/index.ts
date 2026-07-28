import { Elysia, t } from 'elysia';
import { randomUUID } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import { tenantDerive } from '@/guards/tenant.derive';
import { assertClientCapability } from '@/guards/require-capability';
import { intakeConfig } from '@/config/intake';
import { uploadKey, uploadObject } from '@/lib/s3';
import { inspectXlsxWorkbook, estimateBatchCount } from '@/lib/xlsx-inspect';
import { countCsvRows } from '@/lib/csv-inspect';
import { INTAKE_MESSAGES } from '@/lib/intake-messages';
import { revertDocument } from '@/lib/promotion';
import { refreshExistingRollups } from '@/lib/rollups';
import { getActiveCreditRule, getCreditBalance, estimateRequiredCredits } from '@/lib/credits';
import { checkQueueGate } from '@/lib/rate-limit';
import { rateLimitConfig } from '@/config/rate-limit';
import { documents, companies } from '@/db/schema';
import { enqueue, QUEUES } from '@/queue';

const ALLOWED_MIME_EXT: Record<string, string> = {
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.ms-excel': 'xls',
  'text/csv': 'csv',
};

const MESSAGES = INTAKE_MESSAGES;

export const ingestion = new Elysia({ prefix: '/documents' })
  .use(tenantDerive)
  .post(
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

      // Pre-check barato, sin parseo completo (CU-868kfv972: "parsear el libro entero
      // para contar ya es procesar"). También alimenta el bloqueo por créditos de
      // abajo (CU-868kfvaa6): la regla `excel` se cobra por lote, así que hace falta
      // estimar cuántos lotes serán ANTES de encolar.
      //
      // CU-868kh8man: cada formato se inspecciona con lo que permite su estructura.
      // Antes solo se validaba `.xlsx` y el resto pasaba nada más por el cap de
      // tamaño, así que un CSV de 9 MB con cientos de miles de filas entraba entero.
      let estimatedBatches = 1;
      let sheetRowCounts: number[] | null = null;

      if (ext === 'xlsx') {
        sheetRowCounts = inspectXlsxWorkbook(buffer).sheetRowCounts;
      } else if (ext === 'csv') {
        // Un CSV es una sola "hoja"; contar registros respetando comillas es barato
        // (un escaneo de bytes) y no materializa ninguna fila.
        sheetRowCounts = [countCsvRows(buffer)];
      }
      // `.xls` (binario legacy OLE2) no tiene forma barata de inspección: sus caps se
      // aplican en el worker, después del parseo que igual tiene que hacer y ANTES de
      // cualquier llamada a Claude (ver queue/workers/excel-ingest.ts). No queda sin
      // validar, solo se valida más tarde.

      if (sheetRowCounts) {
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

      // Gate de profundidad de cola (CU-868kfvaah, valores de CU-868kfv97f): rechazo
      // sin subir a S3 ni encolar si ya hay demasiados jobs pesados activos/encolados.
      const gate = await checkQueueGate(companyId, 'excel');
      if (!gate.allowed) {
        set.status = 429;
        return { error: msg.queueFull(rateLimitConfig.queueGate.maxJobs), reason: 'queue_full' };
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
  )
  // CU-868kfva7z: list + single-document status polling for the upload UI's
  // pipeline (queued/processing/review/promoted/failed). No separate capability
  // gate — view_dashboard_reports covers all client roles same as upload_excel.
  .get('/', async ({ companyId, role, set, db }) => {
    assertClientCapability(role, 'view_dashboard_reports', set);
    const rows = await db
      .select({
        id: documents.id,
        originalFilename: documents.originalFilename,
        status: documents.status,
        rowCount: documents.rowCount,
        flaggedCount: documents.flaggedCount,
        errorReason: documents.errorReason,
        createdAt: documents.createdAt,
      })
      .from(documents)
      .where(eq(documents.companyId, companyId))
      .orderBy(desc(documents.createdAt))
      .limit(50);
    return { documents: rows };
  })
  /**
   * CU-868kh8nhy: expone la reversión, que existía como `revertDocument()` en
   * lib/promotion.ts desde CU-868kfva9z pero no la alcanzaba ninguna ruta — el
   * criterio "reversión soft-delete por document_id" estaba implementado y muerto.
   *
   * Atomicidad: `db` aquí ya viene dentro de una transacción por request
   * (tenant.derive → reserveCompanyConnection abre `begin`), así que los
   * soft-deletes de transactions/invoices/bills y el cambio de estado del documento
   * se confirman o se revierten juntos.
   */
  .post('/:id/revert', async ({ companyId, role, params, set, db }) => {
    assertClientCapability(role, 'revert_upload', set);

    const [doc] = await db
      .select({ id: documents.id, status: documents.status })
      .from(documents)
      .where(and(eq(documents.id, params.id), eq(documents.companyId, companyId)));
    if (!doc) {
      set.status = 404;
      return { error: 'Document not found' };
    }

    // Idempotente: revertir dos veces no duplica efectos ni es un error para quien
    // llama (p. ej. un doble clic o un reintento de red).
    if (doc.status === 'reverted') {
      return { id: doc.id, status: 'reverted' as const, alreadyReverted: true };
    }

    // Solo un documento promovido tiene filas de negocio que deshacer. Revertir uno
    // en cola/proceso/fallido no tiene sentido y ocultaría un malentendido del
    // usuario detrás de un 200.
    if (doc.status !== 'promoted') {
      set.status = 409;
      return {
        error: `Solo se puede revertir un documento promovido (estado actual: ${doc.status}).`,
      };
    }

    await revertDocument(db, companyId, params.id);
    // Las cifras del dashboard salen de metric_rollups; sin esto seguirían contando
    // las transacciones recién soft-borradas hasta la próxima ingesta.
    await refreshExistingRollups(db, companyId);

    return { id: doc.id, status: 'reverted' as const, alreadyReverted: false };
  })
  .get('/:id', async ({ companyId, role, params, set, db }) => {
    assertClientCapability(role, 'view_dashboard_reports', set);
    const [doc] = await db
      .select()
      .from(documents)
      .where(and(eq(documents.id, params.id), eq(documents.companyId, companyId)));
    if (!doc) {
      set.status = 404;
      return { error: 'Document not found' };
    }
    return {
      id: doc.id,
      originalFilename: doc.originalFilename,
      status: doc.status,
      rowCount: doc.rowCount,
      flaggedCount: doc.flaggedCount,
      errorReason: doc.errorReason,
      createdAt: doc.createdAt,
    };
  });
