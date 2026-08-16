import * as Sentry from '@sentry/bun';
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
    // CU-868kh8pwv. El nombre de la empresa va en el asunto porque quien recibe esto
    // puede no esperar el correo: sin él, "Te invitaron a Macha Finance" es
    // indistinguible de spam. El enlace lleva el token y caduca en 7 días.
    invitation: (companyName: string, acceptUrl: string, invitedByEmail: string) => ({
      subject: `Te invitaron a ${companyName} en Macha Finance`,
      html: `<p><strong>${invitedByEmail}</strong> te invitó a unirte a <strong>${companyName}</strong> en Macha Finance.</p><p><a href="${acceptUrl}">Aceptar invitación</a></p><p>El enlace vence en 7 días. Si no esperabas esta invitación, ignora este correo.</p>`,
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
    invitation: (companyName: string, acceptUrl: string, invitedByEmail: string) => ({
      subject: `You've been invited to ${companyName} on Macha Finance`,
      html: `<p><strong>${invitedByEmail}</strong> invited you to join <strong>${companyName}</strong> on Macha Finance.</p><p><a href="${acceptUrl}">Accept invitation</a></p><p>The link expires in 7 days. If you weren't expecting this invitation, ignore this email.</p>`,
    }),
  },
} as const;

export interface EmailSendPayload {
  companyId: string;
  kind: 'report' | 'alert' | 'invitation';
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

/**
 * Un envío que no salió deja de morir en una tabla que nadie mira.
 *
 * CU-868krkndr. `notifications` guardaba el fallo con su motivo y ahí terminaba todo: no hay
 * pantalla que liste esa tabla, así que "la invitación no llega" solo se descubría cuando el
 * invitado lo decía. Se reporta a Sentry, que es el canal que sí avisa.
 *
 * Va como MENSAJE de nivel `error` y no como excepción lanzada: el worker no debe reintentar
 * —una clave ausente o un dominio sin verificar no se arreglan solos y el backoff solo
 * multiplicaría el ruido— pero un correo que el cliente esperaba y no salió tampoco es un
 * evento informativo.
 *
 * `fingerprint` agrupa por tipo de correo y motivo, NO por destinatario: si un dominio sin
 * verificar tumba doscientos envíos, eso es un problema, no doscientos. Y el destinatario va
 * en el contexto y no en el título por lo mismo.
 */
function reportarFalloDeEnvio(payload: EmailSendPayload, motivo: string): void {
  Sentry.captureMessage(`[email] no se pudo entregar un correo de tipo '${payload.kind}'`, {
    level: 'error',
    tags: { emailKind: payload.kind },
    fingerprint: ['email-delivery-failed', payload.kind, motivo],
    extra: {
      motivo,
      companyId: payload.companyId,
      refId: payload.refId,
      recipientEmail: payload.recipientEmail,
      from: env.resendFromEmail,
    },
  });
}

/** Called only by the email.send worker (src/queue/workers/email-send.ts). */
export async function deliverEmail(db: DB, payload: EmailSendPayload): Promise<void> {
  if (!resend) {
    // No RESEND_API_KEY in this environment — record the attempt as failed rather
    // than silently pretending it sent, so notifications/monitoring stays honest.
    const motivo = 'RESEND_API_KEY not configured';
    await db.insert(notifications).values({
      companyId: payload.companyId,
      kind: payload.kind,
      recipientEmail: payload.recipientEmail,
      refId: payload.refId,
      status: 'failed',
      errorReason: motivo,
    });
    reportarFalloDeEnvio(payload, motivo);
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

  // El registro en base se escribe SIEMPRE primero: si Sentry está caído o sin DSN, el
  // fallo igual queda anotado donde ya estaba.
  if (result.error) reportarFalloDeEnvio(payload, result.error.message);
}

/**
 * CU-868kh8pwv. A diferencia de reportes y alertas, el destinatario puede NO tener
 * todavía cuenta en Macha: el correo es el único canal por el que se entera. Va por la
 * misma cola que el resto (`email.send`), así que hereda su backoff — una caída
 * transitoria de Resend no pierde la invitación, y la fila ya existe en
 * `company_invitations` aunque el correo se retrase.
 */
export async function sendInvitationEmail(params: {
  companyId: string;
  locale: 'es' | 'en';
  invitationId: string;
  companyName: string;
  recipientEmail: string;
  invitedByEmail: string;
  acceptUrl: string;
}): Promise<void> {
  const t = TEMPLATES[params.locale].invitation(
    params.companyName,
    params.acceptUrl,
    params.invitedByEmail,
  );
  await enqueueEmail({
    companyId: params.companyId,
    kind: 'invitation',
    refId: params.invitationId,
    recipientEmail: params.recipientEmail,
    subject: t.subject,
    html: t.html,
  });
}
