import { registerWorker, QUEUES } from '@/queue';
import { withCompanyScope } from '@/lib/db-scope';
import { generateReport } from '@/lib/reports';

type ReportGeneratePayload = {
  companyId: string;
  periodStart: string;
  periodEnd: string;
  frequency: 'daily' | 'weekly';
};

/** CU-868kfvacg/868kfvacr: one company's report per job — enqueued by report-tick.ts's fan-out. */
export function startReportGenerateWorker(): Promise<string> {
  return registerWorker<ReportGeneratePayload>(QUEUES.reportGenerate, async (payload) => {
    await withCompanyScope(payload.companyId, (db) =>
      generateReport(
        db,
        payload.companyId,
        payload.periodStart,
        payload.periodEnd,
        payload.frequency,
      ),
    );
  });
}
