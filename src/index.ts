import { env } from '@/lib/env';
import { initSentry } from '@/lib/sentry';

initSentry();
import { createApp, type App } from '@/app';
import { startQueue } from '@/queue';
import { startExcelIngestWorker } from '@/queue/workers/excel-ingest';
import { startDocumentPromoteWorker } from '@/queue/workers/document-promote';
import { startAlertEvaluateWorker } from '@/queue/workers/alert-evaluate';
import { startReportGenerateWorker } from '@/queue/workers/report-generate';
import { startReportTickWorker } from '@/queue/workers/report-tick';
import { startEmailSendWorker } from '@/queue/workers/email-send';
import { startDbBackupWorker } from '@/queue/workers/db-backup';
import { startPoolWatchWorker } from '@/queue/workers/pool-watch';
import { runStartupIsolationCheck } from '@/lib/db-role-check';
import { evaluateEmailSender } from '@/lib/email-sender-check';
import { sql } from '@/db/client';

// Macha Finance backend — Bun + Elysia. Tenant scoping is enforced in guards/derive
// (see src/guards/). Admin is a separate namespace. Validation uses TypeBox (Elysia).
// La composición vive en src/app.ts para que sea testeable sin abrir puerto ni cola.
export const app = createApp().listen(env.port);

console.log(`macha-backend listening on :${env.port}`);

// CU-868kmxu41: el estado peligroso es "hay con qué cobrar y no se está cobrando".
// Durante un piloto es deliberado; olvidado, es un agujero de ingresos que nadie nota
// porque TODO funciona — los clientes entran, usan el producto y nunca pagan. Se grita
// al arrancar por la misma razón que el aviso de aislamiento de base: un fallo
// silencioso necesita a alguien que lo diga en voz alta.
if (env.billingCheckoutOptional) {
  console.warn(
    env.recurrenteSecretKey
      ? '[billing] MODO PILOTO: BILLING_CHECKOUT_OPTIONAL=true con proveedor de pagos configurado — los registros NO pasan por checkout y NADIE está pagando. Apagar la bandera antes de facturar.'
      : '[billing] MODO PILOTO: BILLING_CHECKOUT_OPTIONAL=true — los registros no pasan por checkout.',
  );
}

// CU-868krkndr: mismo trato que los avisos de arriba. Producción estaba enviando desde
// `onboarding@resend.dev`, el remitente de caja de arena de Resend, que solo entrega al
// dueño de la cuenta — así que las invitaciones "se enviaban" y no llegaban a nadie, sin
// un solo error. Ver src/lib/email-sender-check.ts.
const correoSaliente = evaluateEmailSender({
  apiKey: env.resendApiKey,
  fromEmail: env.resendFromEmail,
  railwayEnvironment: env.railwayEnvironment,
  nodeEnv: env.nodeEnv,
});
if (correoSaliente.warning) console.warn(`[email] ${correoSaliente.warning}`);
export type { App };

// CU-868kjbw5h: verifica contra la conexión REAL que el rol de la app no es el dueño de
// las tablas. Sin esto, `APP_DATABASE_URL` vacía deja RLS/append-only apagados sin un solo
// síntoma. Corre después del listen por el mismo motivo que los workers: que un problema
// de base no impida responder health checks. Aborta solo si REQUIRE_ISOLATED_DB_ROLE=true.
runStartupIsolationCheck(sql, {
  appUrlIsExplicit: env.appDatabaseUrlIsExplicit,
  requireIsolated: env.requireIsolatedDbRole,
  nodeEnv: env.nodeEnv,
}).catch((err) => {
  console.error('[db] no se pudo verificar el aislamiento del rol:', err);
});

// pg-boss workers run in-process with the API for MVP (PRD §5, "workers separables a
// un servicio dedicado por cambio de configuración de despliegue cuando la capacidad
// lo requiera"). Started after the HTTP server so a boss connection failure doesn't
// prevent health checks from at least starting to answer.
startQueue()
  .then(() =>
    Promise.all([
      startExcelIngestWorker(),
      startDocumentPromoteWorker(),
      startAlertEvaluateWorker(),
      startReportGenerateWorker(),
      startReportTickWorker(),
      startEmailSendWorker(),
      startDbBackupWorker(),
      startPoolWatchWorker(),
    ]),
  )
  .catch((err) => {
    console.error('startQueue/workers failed:', err);
  });
