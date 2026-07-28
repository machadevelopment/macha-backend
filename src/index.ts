import { Elysia } from 'elysia';
import * as Sentry from '@sentry/bun';
import { env } from '@/lib/env';
import { initSentry } from '@/lib/sentry';

initSentry();
import { adminCompanies } from '@/modules/admin/companies';
import { adminStagingRows } from '@/modules/admin/staging-rows';
import { adminIndustryTemplates } from '@/modules/admin/industry-templates';
import { adminConfig } from '@/modules/admin/config';
import { adminCreditRules } from '@/modules/admin/credit-rules';
import { adminAlertRules } from '@/modules/admin/alert-rules';
import { adminMonitoring } from '@/modules/admin/monitoring';
import { register } from '@/modules/billing/register';
import { creditsTopup } from '@/modules/billing/credits-topup';
import { billingWebhooks } from '@/modules/billing/webhooks';
import { chats_ } from '@/modules/chats';
import { health } from '@/modules/health';
import { ingestion } from '@/modules/ingestion';
import { industryTemplateDownload } from '@/modules/industry-templates';
import { insights, creditsBalance } from '@/modules/insights';
import { metrics, arAp } from '@/modules/metrics';
import { me } from '@/modules/me';
import { reports_ } from '@/modules/reports';
import { startQueue } from '@/queue';
import { startExcelIngestWorker } from '@/queue/workers/excel-ingest';
import { startAlertEvaluateWorker } from '@/queue/workers/alert-evaluate';
import { startReportGenerateWorker } from '@/queue/workers/report-generate';
import { startReportTickWorker } from '@/queue/workers/report-tick';
import { startEmailSendWorker } from '@/queue/workers/email-send';

// Macha Finance backend — Bun + Elysia. Tenant scoping is enforced in guards/derive
// (see src/guards/). Admin is a separate namespace. Validation uses TypeBox (Elysia).
export const app = new Elysia()
  .use(health)
  .use(ingestion)
  .use(industryTemplateDownload)
  .use(metrics)
  .use(arAp)
  .use(insights)
  .use(creditsBalance)
  .use(chats_)
  .use(reports_)
  .use(adminCompanies)
  .use(adminStagingRows)
  .use(adminIndustryTemplates)
  .use(adminConfig)
  .use(adminCreditRules)
  .use(adminAlertRules)
  .use(adminMonitoring)
  .use(register)
  .use(creditsTopup)
  .use(billingWebhooks)
  .use(me)
  .get('/', () => ({ service: 'macha-backend', env: env.nodeEnv }))
  .onError(({ error }) => {
    Sentry.captureException(error);
  })
  .listen(env.port);

console.log(`macha-backend listening on :${env.port}`);
export type App = typeof app;

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
    ]),
  )
  .catch((err) => {
    console.error('startQueue/workers failed:', err);
  });
