import { randomUUID } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import type { DB } from '@/db/client';
import { reports, reportVersions, companies, companyUsers, users } from '@/db/schema';
import { generateReportNarrative } from '@/lib/anthropic';
import { insertAiUsageEvent } from '@/lib/ai-usage';
import { uploadObject, reportRenderKey } from '@/lib/s3';
import { sendReportReadyEmail } from '@/lib/email';
import { reportUrl } from '@/lib/app-urls';
import { debitCredits, estimateRequiredCredits, getActiveCreditRule } from '@/lib/credits';
import {
  computeReportSections,
  toStoredMetrics,
  DEFAULT_SECTIONS,
  type ReportSection,
  type ReportType,
} from '@/lib/report-sections';
import { buildReportSystemPrompt } from '@/lib/report-prompt';
import { presupuestoDeNarrativa } from '@/lib/report-budget';
import { renderReportHtml } from '@/lib/report-render';

export interface GenerateReportResult {
  reportId: string;
  versionId: string;
}

export interface GenerateReportParams {
  periodStart: string;
  periodEnd: string;
  frequency: 'daily' | 'weekly' | 'on_demand';
  reportType?: ReportType;
  sections?: ReportSection[];
  instructions?: string | null;
  /**
   * Fila de `reports` ya creada por quien pidió el reporte. El endpoint a demanda la crea
   * ANTES de encolar para poder devolverle su id al cliente y que pueda consultar el
   * estado; el tick diario no pasa nada y deja que se busque-o-cree aquí, como siempre.
   */
  reportId?: string;
  /**
   * Si se debitan créditos por esta generación.
   *
   * FALSO POR DEFECTO, y es una decisión, no un olvido: el tick diario genera un reporte
   * para CADA empresa activa todos los días sin que nadie lo pida (report-tick.ts).
   * Cobrarle créditos a una empresa por un trabajo que no solicitó vaciaría el saldo con
   * el que se paga lo que sí pide —un insight, un chat— y convertiría una cortesía del
   * producto en una sangría silenciosa. Se debita solo la vía a demanda, que es la que
   * tiene un usuario detrás decidiendo.
   */
  debit?: boolean;
  /**
   * Idioma en que se escribe la NARRATIVA, cuando hay una persona detrás que lo pidió.
   *
   * CU-868krvuct: Macha generó un reporte con la plataforma en español y salió en inglés.
   * El prompt sí llevaba el idioma —eso ya estaba bien—; lo que estaba mal es DE DÓNDE
   * salía. Se leía de `companies.locale`, que se fija una sola vez en el registro y hoy no
   * se puede editar desde ninguna pantalla (la de Ajustes de empresa es CU-868kj3gm0, que
   * está bloqueada). Y el selector de idioma del producto resultó ser **solo una cookie del
   * navegador** (`app/actions/set-locale.ts` en el frontend): cambiarlo nunca llegaba al
   * servidor. Así que la plataforma se veía en español y el reporte se escribía en el
   * idioma que la empresa hubiera elegido meses antes.
   *
   * Ahora el reporte a demanda viaja con el idioma de QUIEN LO PIDIÓ, que es quien lo va a
   * leer. Ausente = el de la empresa, que es lo correcto para el tick diario: ahí no hay
   * solicitante, el reporte es de la empresa y va a todos sus destinatarios.
   */
  locale?: 'es' | 'en';
}

/**
 * Genera una versión de reporte: calcula las secciones pedidas por SQL, pide la narrativa
 * a Claude, sube el render HTML a S3 e inserta la fila del ledger.
 *
 * CU-B2-QA-20260811 cambió la firma a un objeto de parámetros. Los valores por defecto
 * reproducen EXACTAMENTE el comportamiento anterior (secciones `kpis` +
 * `recommendations`, sin débito), que es lo que necesita el tick diario y también lo que
 * necesitan los jobs que ya estuvieran encolados con el payload viejo en el momento del
 * despliegue.
 */
export async function generateReport(
  db: DB,
  companyId: string,
  params: GenerateReportParams,
): Promise<GenerateReportResult> {
  const { periodStart, periodEnd, frequency } = params;
  const reportType: ReportType = params.reportType ?? 'executive_summary';
  const sections =
    params.sections && params.sections.length > 0 ? params.sections : DEFAULT_SECTIONS[reportType];

  const [company] = await db
    .select({
      locale: companies.locale,
      name: companies.name,
      baseCurrency: companies.baseCurrency,
    })
    .from(companies)
    .where(eq(companies.id, companyId));
  const locale = params.locale ?? company?.locale ?? 'es';

  const data = await computeReportSections(
    db,
    companyId,
    periodStart,
    periodEnd,
    reportType,
    sections,
  );

  // El presupuesto de salida sale de CUÁNTAS secciones se pidieron, no de una constante
  // (CU-868krw2wn: 2048 fijos truncaban los reportes de muchas secciones). Y si aun así
  // se agota, `generateReportNarrative` lanza `AiProviderError('incomplete')` y no se
  // escribe nada — importa acá porque las tres escrituras de abajo (S3, `report_versions`,
  // correo) son irreversibles: el ledger es append-only y el correo ya salió.
  const result = await generateReportNarrative(
    data,
    locale,
    buildReportSystemPrompt({
      locale,
      reportType,
      sections,
      instructions: params.instructions,
      baseCurrency: company?.baseCurrency ?? 'GTQ',
      // CU-868kt984z: `company.name` YA se estaba leyendo acá arriba —lo usa el render
      // HTML— y no llegaba al prompt. Por eso la narrativa hablaba de "Macha Finance".
      companyName: company?.name,
    }),
    presupuestoDeNarrativa(sections),
  );

  await insertAiUsageEvent(db, {
    companyId,
    kind: 'report_generation',
    model: result.model,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    cacheReadTokens: result.cacheReadTokens,
    cacheCreationTokens: result.cacheCreationTokens,
  });

  // La fila de `reports` se busca-o-crea por (empresa, período, FRECUENCIA). La
  // frecuencia entra en la clave desde CU-B2-QA-20260811: sin ella, un reporte a demanda
  // sobre el mismo día que el automático se colgaría como una versión más de aquél, y
  // `report_versions` es append-only, así que esa mezcla no se deshace.
  let report: typeof reports.$inferSelect | undefined;
  if (params.reportId) {
    [report] = await db
      .select()
      .from(reports)
      .where(and(eq(reports.id, params.reportId), eq(reports.companyId, companyId)));
  }
  // La búsqueda por período NO es un `else`: si el id vino y no se encontró, se cae aquí
  // a propósito. Ese caso es la carrera del endpoint a demanda —encola el job dentro de su
  // transacción y la confirma justo después—, y buscar por (empresa, período, frecuencia)
  // da la MISMA fila en cuanto se confirme. Sin este segundo intento, la alternativa sería
  // insertar una fila nueva y dejar dos reportes idénticos donde el usuario pidió uno.
  if (!report) {
    [report] = await db
      .select()
      .from(reports)
      .where(
        and(
          eq(reports.companyId, companyId),
          eq(reports.periodStart, periodStart),
          eq(reports.periodEnd, periodEnd),
          eq(reports.frequency, frequency),
        ),
      );
  }

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
  const renderHtml = renderReportHtml({
    companyName: company?.name ?? '',
    baseCurrency: company?.baseCurrency ?? 'GTQ',
    locale,
    data,
    narrative: result.narrative,
  });

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
      metrics: toStoredMetrics(data),
      narrative: result.narrative,
      s3RenderKey: renderKey,
    })
    .returning();

  await db.update(reports).set({ currentVersionId: version!.id }).where(eq(reports.id, report!.id));

  // Débito de créditos — MISMO patrón que insight y que la carga de Excel: el valor sale
  // del motor de reglas (`credit_rules`, versionadas y editables desde /admin), nunca de
  // una constante en el código, y sin regla activa no se cobra nada. Va DESPUÉS de que la
  // versión existe: si la generación falló, no se cobró (y el bloqueo duro por saldo
  // insuficiente ya ocurrió en el endpoint, antes de encolar el job).
  if (params.debit) {
    const creditRule = await getActiveCreditRule(db, 'report_generation');
    if (creditRule) {
      await debitCredits(db, {
        companyId,
        actionKind: 'report_generation',
        credits: estimateRequiredCredits(creditRule, 1),
        creditRuleId: creditRule.id,
        // `ref_id` es el objeto origen: el REPORTE, que es lo que el usuario ve y lo que
        // aparece en su historial de consumo. La versión es un detalle interno.
        refId: report!.id,
      });
    }
  }

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
