import { Elysia, t } from 'elysia';
import { and, eq } from 'drizzle-orm';
import { adminGuard } from '@/guards/admin.guard';
import { assertStaffCapability } from '@/guards/require-capability';
import { db } from '@/db/client';
import { stagingRows, companies, industryTemplates, industryTemplateVersions } from '@/db/schema';
import { classifySheetRows } from '@/lib/anthropic';
import { insertAiUsageEvent } from '@/lib/ai-usage';
import { logAdminAction } from '@/lib/admin-audit';

/**
 * CU-868kfvaf5 criterio 2: revisión de filas marcadas con edición directa +
 * re-extracción (kind=excel_correction, NUNCA debita créditos — CLAUDE.md).
 *
 * Nota sobre "re-extracción": staging_rows no guarda las celdas crudas originales
 * por fila (solo el payload ya mapeado + flag_reason) — el archivo original vive en
 * S3 a nivel de documento completo, sin manera de correlacionar de vuelta a una fila
 * específica. Re-extraer aquí significa re-correr la clasificación de Claude usando
 * el payload actual + flag_reason como entrada (pidiéndole que reconsidere), no
 * re-parsear el Excel desde cero — es lo que la forma real de los datos permite.
 */
export const adminStagingRows = new Elysia({ prefix: '/admin/staging-rows' })
  .use(adminGuard)
  .get(
    '/',
    async ({ tier, query, set }) => {
      assertStaffCapability(tier, 'review_flagged_rows', set);
      const conditions = [eq(stagingRows.reviewStatus, 'pending')];
      if (query.companyId) conditions.push(eq(stagingRows.companyId, query.companyId));
      if (query.documentId) conditions.push(eq(stagingRows.documentId, query.documentId));
      return db
        .select()
        .from(stagingRows)
        .where(and(...conditions));
    },
    { query: t.Object({ companyId: t.Optional(t.String()), documentId: t.Optional(t.String()) }) },
  )
  .patch(
    '/:id',
    async ({ staffId, tier, params, body, set }) => {
      assertStaffCapability(tier, 'review_flagged_rows', set);
      const [before] = await db.select().from(stagingRows).where(eq(stagingRows.id, params.id));
      if (!before) {
        set.status = 404;
        return { error: 'Staging row not found' };
      }

      await db
        .update(stagingRows)
        .set({
          payload: body.payload ?? before.payload,
          reviewStatus: body.reviewStatus,
          reviewedBy: staffId,
          reviewedAt: new Date(),
        })
        .where(eq(stagingRows.id, params.id));

      await logAdminAction({
        actorStaffId: staffId,
        companyId: before.companyId,
        action: 'staging_row.review',
        targetTable: 'staging_rows',
        targetId: params.id,
        metadata: { before: before.payload, after: body.payload ?? before.payload, reviewStatus: body.reviewStatus },
      });

      return { id: params.id, reviewStatus: body.reviewStatus };
    },
    {
      body: t.Object({
        payload: t.Optional(t.Record(t.String(), t.Unknown())),
        reviewStatus: t.Union([t.Literal('approved'), t.Literal('rejected')]),
      }),
    },
  )
  .post('/:id/reextract', async ({ staffId, tier, params, set }) => {
    assertStaffCapability(tier, 'review_flagged_rows', set);
    const [row] = await db.select().from(stagingRows).where(eq(stagingRows.id, params.id));
    if (!row) {
      set.status = 404;
      return { error: 'Staging row not found' };
    }

    const [company] = await db.select().from(companies).where(eq(companies.id, row.companyId));
    const [template] = await db
      .select()
      .from(industryTemplates)
      .where(eq(industryTemplates.industry, company!.industry));
    const [templateVersion] = await db
      .select()
      .from(industryTemplateVersions)
      .where(eq(industryTemplateVersions.id, template!.currentVersionId!));

    const result = await classifySheetRows({
      templateVersion: templateVersion!,
      sheetName: `revisión (${row.flagReason ?? 'sin razón registrada'})`,
      rows: [[JSON.stringify(row.payload)]],
    });

    const [reclassified] = result.rows;
    if (!reclassified) {
      set.status = 502;
      return { error: 'Claude did not return a classification' };
    }

    await db
      .update(stagingRows)
      .set({
        payload: reclassified.payload,
        confidence: String(reclassified.confidence),
        targetEntity: reclassified.targetEntity,
      })
      .where(eq(stagingRows.id, params.id));

    // kind=excel_correction — never debits credits (CLAUDE.md non-negotiable).
    await insertAiUsageEvent(db, {
      companyId: row.companyId,
      kind: 'excel_correction',
      refId: row.documentId,
      model: result.model,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
    });

    await logAdminAction({
      actorStaffId: staffId,
      companyId: row.companyId,
      action: 'staging_row.reextract',
      targetTable: 'staging_rows',
      targetId: params.id,
      metadata: { before: row.payload, after: reclassified.payload },
    });

    return { id: params.id, payload: reclassified.payload, confidence: reclassified.confidence };
  });
