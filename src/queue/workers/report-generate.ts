import { registerWorker, QUEUES } from '@/queue';
import { withCompanyScope } from '@/lib/db-scope';
import { generateReport } from '@/lib/reports';
import { normalizeSections, type ReportType } from '@/lib/report-sections';

/**
 * CU-868kfvacg/868kfvacr: el reporte de UNA empresa por job.
 *
 * Dos productores desde CU-B2-QA-20260811: el fan-out del tick diario (report-tick.ts) y
 * el endpoint a demanda (`POST /reports/generate`). Los campos nuevos son TODOS opcionales
 * a propósito — un job encolado con el payload viejo justo antes del despliegue tiene que
 * seguir corriendo, y `generateReport` ya toma por defecto exactamente el comportamiento
 * anterior.
 *
 * `sections` se vuelve a normalizar aquí aunque el endpoint ya lo hizo: el payload de un
 * job es un JSON en una tabla, no una entrada validada por TypeBox, y esto corre con
 * privilegios de servidor sobre el ledger de una empresa. Normalizar dos veces cuesta un
 * filtro sobre seis literales.
 */
type ReportGeneratePayload = {
  companyId: string;
  periodStart: string;
  periodEnd: string;
  frequency: 'daily' | 'weekly' | 'on_demand';
  reportId?: string;
  reportType?: ReportType;
  sections?: string[];
  instructions?: string | null;
  debit?: boolean;
};

export function startReportGenerateWorker(): Promise<string> {
  return registerWorker<ReportGeneratePayload>(QUEUES.reportGenerate, async (payload) => {
    const sections = payload.sections ? normalizeSections(payload.sections) : undefined;
    await withCompanyScope(payload.companyId, (db) =>
      generateReport(db, payload.companyId, {
        periodStart: payload.periodStart,
        periodEnd: payload.periodEnd,
        frequency: payload.frequency,
        reportId: payload.reportId,
        reportType: payload.reportType,
        sections,
        instructions: payload.instructions,
        debit: payload.debit,
      }),
    );
  });
}
