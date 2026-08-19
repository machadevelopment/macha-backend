import * as Sentry from '@sentry/bun';
import { resend } from './resend';
import { env } from './env';
import { type DB } from '@/db/client';
import { notifications } from '@/db/schema';
import { enqueue, QUEUES } from '@/queue';
import { renderBrandedEmail, destacado } from '@/lib/email-shell';

/**
 * CU-868kfvad9: Resend, plantillas ES/EN, idioma según companies.locale. "Seam" de
 * migración a SES (criterio 3): toda la app pasa por sendEmailJob() → el worker de
 * email.send es el ÚNICO lugar que llama a Resend — el día que se cambie de
 * proveedor, solo ese worker cambia. Nunca adjunta el reporte/PDF: siempre un link a
 * la vista in-app autenticada. Encolado (no enviado inline) para que las fallas
 * transitorias de Resend se reintenten con el backoff de RETRY_POLICY del queue,
 * no con la lógica propia de Resend.
 */
/**
 * ═══ LOS TRES CORREOS, SOBRE EL SHELL DE MARCA (CU-868ku6jn1) ═══
 *
 * Antes cada entrada devolvía su propio HTML plano —`<p><strong>...</strong> te invitó</p>`—
 * y Jose lo reportó con la captura de un correo real: sin logo, sin marca, indistinguible de
 * spam. Ahora cada una aporta solo lo suyo (título, cuerpo, botón) y el maquetado vive
 * completo en `lib/email-shell.ts`, extraído de la plantilla que él aprobó.
 *
 * Lo que NO cambió: la firma de estas funciones, el `{ subject, html }` que devuelven, el
 * corte ES/EN, `deliverEmail()`, la cola `email.send` y la tabla `notifications`. El shell se
 * insertó por debajo a propósito — así el arreglo no toca el camino de entrega, que ya
 * funciona y tiene su propio reporte de fallos a Sentry.
 *
 * El asunto sigue en TEXTO PLANO y sin escapar, y eso es correcto: no es HTML. Escaparlo
 * mostraría `&amp;` literal en la bandeja de entrada de una empresa que se llame "Pérez & Co".
 */
export const TEMPLATES = {
  es: {
    reportReady: (viewUrl: string) => ({
      subject: 'Tu reporte financiero está listo',
      html: renderBrandedEmail({
        locale: 'es',
        title: 'Tu reporte financiero está listo',
        bodyHtml:
          'Tu reporte ejecutivo ya está disponible con el análisis del período. ' +
          'Ábrelo para ver tus cifras, la tendencia y lo que Macha encontró en ellas.',
        ctaLabel: 'Ver reporte',
        ctaUrl: viewUrl,
      }),
    }),
    alertTriggered: (label: string, viewUrl: string) => ({
      subject: `Alerta: ${label}`,
      html: renderBrandedEmail({
        locale: 'es',
        // El nombre de la regla va en el título porque es LO QUE PASÓ: un asunto que solo
        // dijera "Alerta" obliga a abrir el correo para saber si urge.
        title: label,
        bodyHtml: `Se disparó la alerta ${destacado(label)} en tu empresa. Revisa el detalle para ver qué la activó y con qué cifras.`,
        ctaLabel: 'Ver detalle',
        ctaUrl: viewUrl,
      }),
    }),
    // CU-868kh8pwv. El nombre de la empresa va en el asunto porque quien recibe esto
    // puede no esperar el correo: sin él, "Te invitaron a Macha Finance" es
    // indistinguible de spam. El enlace lleva el token y caduca en 7 días.
    invitation: (companyName: string, acceptUrl: string, invitedByEmail: string) => ({
      subject: `Te invitaron a ${companyName} en Macha Finance`,
      html: renderBrandedEmail({
        locale: 'es',
        title: `Te invitaron a ${companyName}`,
        bodyHtml: `${destacado(invitedByEmail)} te invitó a unirte a ${destacado(companyName)} en Macha Finance. Acepta la invitación para crear tu cuenta y empezar a ver el negocio con claridad.`,
        ctaLabel: 'Aceptar invitación',
        ctaUrl: acceptUrl,
        footnote:
          'El enlace vence en 7 días. Si no esperabas esta invitación, puedes ignorar este correo sin problema.',
        // Único de los tres que lo lleva: quien lo recibe puede no tener cuenta y estar
        // leyendo desde un cliente que no deja apretar botones.
        showPlainLink: true,
      }),
    }),
  },
  en: {
    reportReady: (viewUrl: string) => ({
      subject: 'Your financial report is ready',
      html: renderBrandedEmail({
        locale: 'en',
        title: 'Your financial report is ready',
        bodyHtml:
          'Your executive report is now available with the analysis for the period. ' +
          'Open it to see your figures, the trend, and what Macha found in them.',
        ctaLabel: 'View report',
        ctaUrl: viewUrl,
      }),
    }),
    alertTriggered: (label: string, viewUrl: string) => ({
      subject: `Alert: ${label}`,
      html: renderBrandedEmail({
        locale: 'en',
        title: label,
        bodyHtml: `The ${destacado(label)} alert was triggered for your company. Check the detail to see what set it off and with which figures.`,
        ctaLabel: 'View detail',
        ctaUrl: viewUrl,
      }),
    }),
    invitation: (companyName: string, acceptUrl: string, invitedByEmail: string) => ({
      subject: `You've been invited to ${companyName} on Macha Finance`,
      html: renderBrandedEmail({
        locale: 'en',
        title: `You've been invited to ${companyName}`,
        bodyHtml: `${destacado(invitedByEmail)} invited you to join ${destacado(companyName)} on Macha Finance. Accept the invitation to create your account and start seeing your business clearly.`,
        ctaLabel: 'Accept invitation',
        ctaUrl: acceptUrl,
        footnote:
          "The link expires in 7 days. If you weren't expecting this invitation, you can safely ignore this email.",
        showPlainLink: true,
      }),
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
