import { registerWorker, QUEUES } from '@/queue';
import { withCompanyScope } from '@/lib/db-scope';
import { evaluateAlerts } from '@/lib/alerts';

type AlertEvaluatePayload = { companyId: string; documentId?: string };

/** CU-868kfvad3 — enqueued by excel-ingest.ts after a successful promotion. */
export function startAlertEvaluateWorker(): Promise<string> {
  return registerWorker<AlertEvaluatePayload>(QUEUES.alertEvaluate, async (payload) => {
    await withCompanyScope(payload.companyId, (db) =>
      evaluateAlerts(db, payload.companyId, payload.documentId),
    );
  });
}
