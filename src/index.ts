import { env } from '@/lib/env';
import { initSentry } from '@/lib/sentry';

initSentry();
import { createApp, type App } from '@/app';
import { startQueue } from '@/queue';
import { startExcelIngestWorker } from '@/queue/workers/excel-ingest';
import { startAlertEvaluateWorker } from '@/queue/workers/alert-evaluate';
import { startReportGenerateWorker } from '@/queue/workers/report-generate';
import { startReportTickWorker } from '@/queue/workers/report-tick';
import { startEmailSendWorker } from '@/queue/workers/email-send';
import { startDbBackupWorker } from '@/queue/workers/db-backup';

// Macha Finance backend — Bun + Elysia. Tenant scoping is enforced in guards/derive
// (see src/guards/). Admin is a separate namespace. Validation uses TypeBox (Elysia).
// La composición vive en src/app.ts para que sea testeable sin abrir puerto ni cola.
export const app = createApp().listen(env.port);

console.log(`macha-backend listening on :${env.port}`);
export type { App };

// pg-boss workers run in-process with the API for MVP (PRD §5, "workers separables a
// un servicio dedicado por cambio de configuración de despliegue cuando la capacidad
// lo requiera"). Started after the HTTP server so a boss connection failure doesn't
// prevent health checks from at least starting to answer.
startQueue()
  .then(() =>
    Promise.all([
      startExcelIngestWorker(),
      startAlertEvaluateWorker(),
      startReportGenerateWorker(),
      startReportTickWorker(),
      startEmailSendWorker(),
      startDbBackupWorker(),
    ]),
  )
  .catch((err) => {
    console.error('startQueue/workers failed:', err);
  });
