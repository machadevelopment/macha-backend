import { resend } from './resend';
import { env } from './env';
import { type DB } from '@/db/client';
import { notifications } from '@/db/schema';
import { enqueue, QUEUES } from '@/queue';

/**
 * CU-868kfvad9: Resend, plantillas ES/EN, idioma según companies.locale. "Seam" de
 * migración a SES (criterio 3): toda la app pasa por sendEmailJob() → el worker de
 * email.send es el ÚNICO lugar que llama a Resend — el día que se cambie de
 * proveedor, solo ese worker cambia. Nunca adjunta el reporte/PDF: siempre un link a
 * la vista in-app autenticada. Encolado (no enviado inline) para que las fallas
 * transitorias de Resend se reintenten con el backoff de RETRY_POLICY del queue,
 * no con la lógica propia de Resend.
 */
export const TEMPLATES = {
  es: {
    reportReady: (viewUrl: string) => ({
      subject: 'Tu reporte financiero está listo',
      html: `<p>Tu reporte ejecutivo ya está disponible.</p><p><a href="${viewUrl}">Ver reporte</a></p>`,
    }),
    alertTriggered: (label: string, viewUrl: string) => ({
      subject: `Alerta: ${label}`,
      html: `<p>Se disparó la alerta <strong>${label}</strong> en tu empresa.</p><p><a href="${viewUrl}">Ver detalle</a></p>`,
    }),
  },
  en: {
    reportReady: (viewUrl: string) => ({
      subject: 'Your financial report is ready',
      html: `<p>Your executive report is now available.</p><p><a href="${viewUrl}">View report</a></p>`,
    }),
    alertTriggered: (label: string, viewUrl: string) => ({
      subject: `Alert: ${label}`,
      html: `<p>The <strong>${label}</strong> alert was triggered for your company.</p><p><a href="${viewUrl}">View detail</a></p>`,
    }),
  },
} as const;

export interface EmailSendPayload {
  companyId: string;
  kind: 'report' | 'alert';
  refId: string;
  recipientEmail: string;
  subject: string;
  html: string;
}

async function enqueueEmail(payload: EmailSendPayload): Promise<void> {
  await enqueue(QUEUES.emailSend, payload);
}

export async function sendReportReadyEmail(params: {
  companyId: string;
  locale: 'es' | 'en';
  reportVersionId: string;
  recipientEmail: string;
  viewUrl: string;
}): Promise<void> {
  const t = TEMPLATES[params.locale].reportReady(params.viewUrl);
  await enqueueEmail({
    companyId: params.companyId,
    kind: 'report',
    refId: params.reportVersionId,
    recipientEmail: params.recipientEmail,
    subject: t.subject,
    html: t.html,
  });
}

export async function sendAlertTriggeredEmail(params: {
  companyId: string;
  locale: 'es' | 'en';
  alertEventId: string;
  ruleLabel: string;
  recipientEmail: string;
  viewUrl: string;
}): Promise<void> {
  const t = TEMPLATES[params.locale].alertTriggered(params.ruleLabel, params.viewUrl);
  await enqueueEmail({
    companyId: params.companyId,
    kind: 'alert',
    refId: params.alertEventId,
    recipientEmail: params.recipientEmail,
    subject: t.subject,
    html: t.html,
  });
}

/** Called only by the email.send worker (src/queue/workers/email-send.ts). */
export async function deliverEmail(db: DB, payload: EmailSendPayload): Promise<void> {
  if (!resend) {
    // No RESEND_API_KEY in this environment — record the attempt as failed rather
    // than silently pretending it sent, so notifications/monitoring stays honest.
    await db.insert(notifications).values({
      companyId: payload.companyId,
      kind: payload.kind,
      recipientEmail: payload.recipientEmail,
      refId: payload.refId,
      status: 'failed',
      errorReason: 'RESEND_API_KEY not configured',
    });
    return;
  }

  const result = await resend.emails.send({
    from: env.resendFromEmail,
    to: payload.recipientEmail,
    subject: payload.subject,
    html: payload.html,
  });

  await db.insert(notifications).values({
    companyId: payload.companyId,
    kind: payload.kind,
    recipientEmail: payload.recipientEmail,
    refId: payload.refId,
    resendMessageId: result.data?.id,
    status: result.error ? 'failed' : 'sent',
    errorReason: result.error?.message,
  });
}
