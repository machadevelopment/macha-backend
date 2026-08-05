import { randomUUID } from 'node:crypto';
import { and, desc, eq, gte, isNull, lte, sql as rawSql } from 'drizzle-orm';
import type { DB } from '@/db/client';
import {
  reports,
  reportVersions,
  transactions,
  invoices,
  bills,
  companies,
  companyUsers,
  users,
} from '@/db/schema';
import { generateReportNarrative } from '@/lib/anthropic';
import { insertAiUsageEvent } from '@/lib/ai-usage';
import { uploadObject, reportRenderKey } from '@/lib/s3';
import { sendReportReadyEmail } from '@/lib/email';
import { reportUrl } from '@/lib/app-urls';

/**
 * CU-868kfvacr/868kfvacg: métricas calculadas en SQL directo sobre el ledger para el
 * rango exacto del reporte (periodStart..periodEnd) — NO vía metric_rollups, porque
 * los reportes son diarios/semanales (data model.md reports.frequency) y los rollups
 * solo tienen granularidad month/quarter/year; forzarlos a ese molde perdería
 * precisión en el rango real del reporte. La IA nunca ve esta query, solo su
 * resultado (regla no negociable: "la IA narra, nunca calcula").
 */
async function computeReportMetrics(
  db: DB,
  companyId: string,
  periodStart: string,
  periodEnd: string,
) {
  const byType = await db
    .select({ type: transactions.type, total: rawSql<string>`sum(${transactions.amountBase})` })
    .from(transactions)
    .where(
      and(
        eq(transactions.companyId, companyId),
        isNull(transactions.deletedAt),
        gte(transactions.date, periodStart),
        lte(transactions.date, periodEnd),
      ),
    )
    .groupBy(transactions.type);

  const totals: Record<string, number> = { revenue: 0, cogs: 0, opex: 0, other: 0 };
  for (const row of byType) totals[row.type] = Number(row.total);

  const [arRow] = await db
    .select({ total: rawSql<string>`coalesce(sum(${invoices.amountBase}), 0)` })
    .from(invoices)
    .where(
      and(
        eq(invoices.companyId, companyId),
        eq(invoices.status, 'open'),
        isNull(invoices.deletedAt),
      ),
    );
  const [apRow] = await db
    .select({ total: rawSql<string>`coalesce(sum(${bills.amountBase}), 0)` })
    .from(bills)
    .where(and(eq(bills.companyId, companyId), eq(bills.status, 'open'), isNull(bills.deletedAt)));

  return {
    periodStart,
    periodEnd,
    revenue: totals.revenue,
    cogs: totals.cogs,
    opex: totals.opex,
    other: totals.other,
    margin: totals.revenue! - totals.cogs!,
    accountsReceivableOpen: Number(arRow?.total ?? 0),
    accountsPayableOpen: Number(apRow?.total ?? 0),
  };
}

export interface GenerateReportResult {
  reportId: string;
  versionId: string;
}

export async function generateReport(
  db: DB,
  companyId: string,
  periodStart: string,
  periodEnd: string,
  frequency: 'daily' | 'weekly',
): Promise<GenerateReportResult> {
  const [company] = await db
    .select({ locale: companies.locale })
    .from(companies)
    .where(eq(companies.id, companyId));
  const locale = company?.locale ?? 'es';

  const metrics = await computeReportMetrics(db, companyId, periodStart, periodEnd);
  const result = await generateReportNarrative(metrics, locale);

  await insertAiUsageEvent(db, {
    companyId,
    kind: 'report_generation',
    model: result.model,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
  });

  let [report] = await db
    .select()
    .from(reports)
    .where(
      and(
        eq(reports.companyId, companyId),
        eq(reports.periodStart, periodStart),
        eq(reports.periodEnd, periodEnd),
      ),
    );
  if (!report) {
    [report] = await db
      .insert(reports)
      .values({ companyId, periodStart, periodEnd, frequency })
      .returning();
  }

  const [lastVersion] = await db
    .select({ version: reportVersions.version })
    .from(reportVersions)
    .where(eq(reportVersions.reportId, report!.id))
    .orderBy(desc(reportVersions.version))
    .limit(1);

  // CU-868kjc5pj: el id se genera aquí, no en la base. `report_versions` es un ledger
  // append-only (REVOKE UPDATE,DELETE en la migración 0010), así que la fila tiene que
  // insertarse YA COMPLETA — antes esto insertaba y luego hacía UPDATE para poner
  // s3_render_key, porque la clave de S3 se construye con el id de la versión. Con el
  // rol macha_app ese UPDATE es `permission denied` y el reporte no se genera nunca.
  const versionId = randomUUID();
  const renderHtml = `<!doctype html><html><head><meta charset="utf-8"><title>Reporte ${periodStart} — ${periodEnd}</title></head>
<body>
  <h1>Reporte ejecutivo (${periodStart} — ${periodEnd})</h1>
  <p><strong>Ingresos:</strong> ${metrics.revenue} · <strong>Costo de ventas:</strong> ${metrics.cogs} · <strong>Margen:</strong> ${metrics.margin}</p>
  <p><strong>Por cobrar abierto:</strong> ${metrics.accountsReceivableOpen} · <strong>Por pagar abierto:</strong> ${metrics.accountsPayableOpen}</p>
  <div>${result.narrative.replace(/\n/g, '<br/>')}</div>
</body></html>`;

  // El render sube ANTES del insert: si falla, no queda una fila de ledger apuntando a
  // un objeto inexistente. Al revés (insert y luego subida fallida) sería irreparable,
  // porque la fila no se puede corregir ni borrar.
  const renderKey = reportRenderKey(companyId, versionId);
  await uploadObject(renderKey, Buffer.from(renderHtml, 'utf-8'), 'text/html');

  const [version] = await db
    .insert(reportVersions)
    .values({
      id: versionId,
      companyId,
      reportId: report!.id,
      version: (lastVersion?.version ?? 0) + 1,
      metrics,
      narrative: result.narrative,
      s3RenderKey: renderKey,
    })
    .returning();

  await db.update(reports).set({ currentVersionId: version!.id }).where(eq(reports.id, report!.id));

  const recipients = await db
    .select({ email: users.email })
    .from(companyUsers)
    .innerJoin(users, eq(users.id, companyUsers.userId))
    .where(
      and(
        eq(companyUsers.companyId, companyId),
        eq(companyUsers.status, 'active'),
        eq(companyUsers.receivesReports, true),
      ),
    );

  for (const recipient of recipients) {
    await sendReportReadyEmail({
      companyId,
      locale,
      reportVersionId: version!.id,
      recipientEmail: recipient.email,
      // CU-868kh8jjy: el link va al REPORTE, no a la versión — `/reports/[id]`
      // resuelve `reports.id`, así que mandar `version.id` daba 404 en todo email.
      // (`refId` arriba sí guarda el versionId: eso es trazabilidad de qué versión
      // disparó el envío, no navegación.)
      viewUrl: reportUrl(report!.id),
    });
  }

  return { reportId: report!.id, versionId: version!.id };
}
