import { Elysia, t } from 'elysia';
import { and, desc, eq } from 'drizzle-orm';
import { tenantDerive } from '@/guards/tenant.derive';
import { assertClientCapability } from '@/guards/require-capability';
import { companies, reports, reportVersions } from '@/db/schema';
import { presignGet, uploadObject, reportRenderKey } from '@/lib/s3';

/**
 * CU-868kfvacr (criterios 2/3) + CU-868kfvad1 (edición). `report_versions` es
 * append-only — "editar" un reporte crea una versión NUEVA con la narrativa
 * editada, reusando las mismas métricas (calculadas en SQL, no editables); nunca se
 * hace UPDATE sobre una versión existente.
 */
export const reports_ = new Elysia({ prefix: '/reports' })
  .use(tenantDerive)
  .get('/', async ({ companyId, role, set, db }) => {
    assertClientCapability(role, 'view_dashboard_reports', set);
    return db
      .select({
        id: reports.id,
        periodStart: reports.periodStart,
        periodEnd: reports.periodEnd,
        frequency: reports.frequency,
        currentVersionId: reports.currentVersionId,
        updatedAt: reports.updatedAt,
      })
      .from(reports)
      .where(eq(reports.companyId, companyId))
      .orderBy(desc(reports.updatedAt));
  })
  .get('/:id', async ({ companyId, role, params, set, db }) => {
    assertClientCapability(role, 'view_dashboard_reports', set);
    const [report] = await db
      .select()
      .from(reports)
      .where(and(eq(reports.id, params.id), eq(reports.companyId, companyId)));
    if (!report?.currentVersionId) {
      set.status = 404;
      return { error: 'Report not found' };
    }
    const [version] = await db
      .select()
      .from(reportVersions)
      .where(eq(reportVersions.id, report.currentVersionId));

    // CU-868kh8rz8 criterio 2: la moneda base sale de la empresa. Antes el detalle de
    // reporte la asumía 'GTQ' hardcodeada en el cliente, así que una empresa con
    // baseCurrency='USD' veía sus montos etiquetados como quetzales. `metrics` no trae
    // moneda propia (son amount_base ya convertidos), por eso viaja aparte aquí.
    const [company] = await db
      .select({ baseCurrency: companies.baseCurrency })
      .from(companies)
      .where(eq(companies.id, companyId));

    return {
      id: report.id,
      periodStart: report.periodStart,
      periodEnd: report.periodEnd,
      frequency: report.frequency,
      baseCurrency: company?.baseCurrency ?? 'GTQ',
      // CU-868kh8uau: el id de la VERSIÓN actual, expuesto explícitamente. El
      // deep-link a chat mandaba `reports.id` en el campo `reportVersionId` y, como
      // `chats.report_version_id` no tiene FK, se persistía una referencia falsa en
      // silencio. El cliente no puede derivar este id de ningún otro campo — si no se
      // devuelve, no hay forma de mandar el correcto.
      versionId: report.currentVersionId,
      version: version?.version,
      metrics: version?.metrics,
      narrative: version?.narrative,
      createdAt: version?.createdAt,
    };
  })
  .get('/:id/view', async ({ companyId, role, params, set, db }) => {
    assertClientCapability(role, 'view_dashboard_reports', set);
    const [report] = await db
      .select({ currentVersionId: reports.currentVersionId })
      .from(reports)
      .where(and(eq(reports.id, params.id), eq(reports.companyId, companyId)));
    if (!report?.currentVersionId) {
      set.status = 404;
      return { error: 'Report not found' };
    }
    const [version] = await db
      .select({ s3RenderKey: reportVersions.s3RenderKey })
      .from(reportVersions)
      .where(eq(reportVersions.id, report.currentVersionId));
    if (!version?.s3RenderKey) {
      set.status = 404;
      return { error: 'Render not available' };
    }
    // Short-lived presigned URL (criterio 1) — the client fetches this and the
    // browser navigates to S3 directly; we never proxy the HTML bytes ourselves.
    const url = await presignGet(version.s3RenderKey, 120);
    return { url };
  })
  .post(
    '/:id/versions',
    async ({ companyId, userId, role, params, body, set, db }) => {
      assertClientCapability(role, 'edit_send_reports', set);
      const [report] = await db
        .select()
        .from(reports)
        .where(and(eq(reports.id, params.id), eq(reports.companyId, companyId)));
      if (!report?.currentVersionId) {
        set.status = 404;
        return { error: 'Report not found' };
      }
      const [current] = await db
        .select()
        .from(reportVersions)
        .where(eq(reportVersions.id, report.currentVersionId));

      const [newVersion] = await db
        .insert(reportVersions)
        .values({
          companyId,
          reportId: report.id,
          version: current!.version + 1,
          metrics: current!.metrics,
          narrative: body.narrative,
          editedBy: userId,
        })
        .returning();

      const renderHtml = `<!doctype html><html><head><meta charset="utf-8"></head><body>${body.narrative.replace(/\n/g, '<br/>')}</body></html>`;
      const renderKey = reportRenderKey(companyId, newVersion!.id);
      await uploadObject(renderKey, Buffer.from(renderHtml, 'utf-8'), 'text/html');
      await db
        .update(reportVersions)
        .set({ s3RenderKey: renderKey })
        .where(eq(reportVersions.id, newVersion!.id));
      await db
        .update(reports)
        .set({ currentVersionId: newVersion!.id })
        .where(eq(reports.id, report.id));

      set.status = 201;
      return { id: report.id, version: newVersion!.version };
    },
    { body: t.Object({ narrative: t.String() }) },
  );
