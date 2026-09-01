import * as Sentry from '@sentry/bun';
import { resend } from './resend';
import { env } from './env';
import { type DB } from '@/db/client';
import { notifications } from '@/db/schema';
import { enqueue, QUEUES } from '@/queue';
import { renderBrandedEmail, destacado, escaparHtml } from '@/lib/email-shell';

/** Texto del lead que va dentro de `bodyHtml` (ya escapado). */
function escaparEnCuerpo(texto: string): string {
  return escaparHtml(texto).replace(/\n/g, '<br>');
}

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
    /**
     * ═══ "TU ARCHIVO NECESITA TU ATENCIÓN" (CU-868kyur58) ═══
     *
     * El copy sale del HTML que aprobó Jose, palabra por palabra. Cuatro decisiones que están
     * en ese texto y conviene no perder al editarlo:
     *
     *  · **"Ya casi terminamos de leer"** y no "no pudimos leer": la carga entró, lo limpio ya
     *    está en su dashboard. Un correo que suene a fallo hace que el cliente abra la app
     *    esperando encontrarla rota.
     *  · **La cifra son CONCEPTOS, no filas marcadas.** El mockup dice "6 filas" porque en ese
     *    ejemplo coinciden; acá se manda lo que el cliente va a VER al entrar, que son las
     *    preguntas. Prometer 60 y mostrar 6 destruye el aviso para siempre.
     *  · **"te tomará menos de un minuto"** es la promesa que justifica la interrupción, y por
     *    eso el disparador exige que haya conceptos contestables: sin eso sería mentira.
     *  · ⚠️ **EL PIE CAMBIÓ CON EL PORTÓN (migración 0042).** Decía "el resto de tus datos ya
     *    están en tu dashboard", y desde que ninguna carga se promueve sola **eso es falso**:
     *    lo que hay es una carga esperando su visto bueno. Es exactamente la mentira que el
     *    banner de ingesta sostuvo tres semanas después de la promoción parcial, y este correo
     *    la habría heredado. Los dos textos hablan de la misma carga con minutos de diferencia
     *    y tienen que decir lo mismo.
     */
    reviewNeeded: (datos: { archivos: string[]; conceptos: number; ctaUrl: string }) => {
      const uno = datos.archivos.length === 1;
      const lista = datos.archivos.map((a) => destacado(a)).join(', ');
      return {
        subject: uno
          ? `Tu archivo necesita tu atención: ${datos.archivos[0]}`
          : `Tus ${datos.archivos.length} cargas necesitan tu atención`,
        html: renderBrandedEmail({
          locale: 'es',
          title: uno ? 'Tu archivo necesita tu atención' : 'Tus cargas necesitan tu atención',
          bodyHtml:
            `Ya casi terminamos de leer ${lista}. ` +
            (datos.conceptos === 1
              ? 'Nos quedó <strong>1 concepto</strong> que solo tú puedes clasificar bien'
              : `Nos quedaron <strong>${datos.conceptos} conceptos</strong> que solo tú puedes clasificar bien`) +
            ' — te tomará menos de un minuto.',
          ctaLabel: 'Revisar y confirmar',
          ctaUrl: datos.ctaUrl,
          footnote:
            'Tu carga está lista y esperando tu confirmación: en cuanto la revises, entra a tu dashboard.',
        }),
      };
    },
    /**
     * Aviso interno al equipo cuando alguien pide demo desde la landing. No es un correo al
     * lead: es el aviso ENCIMA de la fila en `demo_requests`. El cuerpo lleva los datos que
     * escribió; el botón abre el panel donde está la lista completa.
     */
    demoRequest: (datos: {
      nombre: string;
      empresa: string;
      correo: string;
      telefono: string;
      mensaje: string;
      panelUrl: string;
    }) => ({
      subject: `Nueva solicitud de demo: ${datos.empresa}`,
      html: renderBrandedEmail({
        locale: 'es',
        title: 'Nueva solicitud de demo',
        bodyHtml:
          `${destacado(datos.nombre)} de ${destacado(datos.empresa)} pidió una demo.<br><br>` +
          `<strong>Correo:</strong> ${escaparEnCuerpo(datos.correo)}<br>` +
          (datos.telefono
            ? `<strong>Teléfono:</strong> ${escaparEnCuerpo(datos.telefono)}<br>`
            : '') +
          (datos.mensaje
            ? `<br><strong>Mensaje:</strong><br>${escaparEnCuerpo(datos.mensaje)}`
            : ''),
        ctaLabel: 'Ver en el panel',
        ctaUrl: datos.panelUrl,
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
    /** Ver la nota de la versión en español: el copy es una traducción, no una variante. */
    reviewNeeded: (datos: { archivos: string[]; conceptos: number; ctaUrl: string }) => {
      const uno = datos.archivos.length === 1;
      const lista = datos.archivos.map((a) => destacado(a)).join(', ');
      return {
        subject: uno
          ? `Your file needs your input: ${datos.archivos[0]}`
          : `Your ${datos.archivos.length} uploads need your input`,
        html: renderBrandedEmail({
          locale: 'en',
          title: uno ? 'Your file needs your input' : 'Your uploads need your input',
          bodyHtml:
            `We're almost done reading ${lista}. ` +
            (datos.conceptos === 1
              ? 'There is <strong>1 item</strong> only you can classify correctly'
              : `There are <strong>${datos.conceptos} items</strong> only you can classify correctly`) +
            ' — it will take you less than a minute.',
          ctaLabel: 'Review and confirm',
          ctaUrl: datos.ctaUrl,
          footnote:
            'Your upload is ready and waiting for your confirmation: once you review it, it goes into your dashboard.',
        }),
      };
    },
    demoRequest: (datos: {
      nombre: string;
      empresa: string;
      correo: string;
      telefono: string;
      mensaje: string;
      panelUrl: string;
    }) => ({
      subject: `New demo request: ${datos.empresa}`,
      html: renderBrandedEmail({
        locale: 'en',
        title: 'New demo request',
        bodyHtml:
          `${destacado(datos.nombre)} from ${destacado(datos.empresa)} requested a demo.<br><br>` +
          `<strong>Email:</strong> ${escaparEnCuerpo(datos.correo)}<br>` +
          (datos.telefono ? `<strong>Phone:</strong> ${escaparEnCuerpo(datos.telefono)}<br>` : '') +
          (datos.mensaje
            ? `<br><strong>Message:</strong><br>${escaparEnCuerpo(datos.mensaje)}`
            : ''),
        ctaLabel: 'Open in admin',
        ctaUrl: datos.panelUrl,
      }),
    }),
  },
} as const;

export interface EmailSendPayload {
  /**
   * Null solo en correos de plataforma (aviso de demo): no hay empresa que scopear y
   * `notifications` exige `company_id`. El worker salta el scope y no escribe esa tabla.
   */
  companyId: string | null;
  kind: 'report' | 'alert' | 'invitation' | 'demo_request' | 'review_needed';
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
 * El correo de "necesitamos que confirmes unos conceptos" (CU-868kyur58).
 *
 * ⚠️ **CONSOLIDADO POR EMPRESA, NO POR DOCUMENTO.** Recibe la lista de archivos y el total de
 * conceptos, y manda UN correo. En el onboarding un cliente sube tres o cuatro archivos casi a
 * la vez: tres correos en cinco minutos se leen como un producto que no sabe lo que está
 * haciendo, y el segundo ya no se abre.
 *
 * ⚠️ **`refId` es el DOCUMENTO y no la empresa**, aunque el correo sea consolidado, y ahí está
 * la idempotencia: el worker escribe una fila de `notifications` por cada documento cubierto,
 * así que el que ya recibió aviso no vuelve a disparar uno. Es la única forma de que las dos
 * reglas del ticket —"consolidar" y "nunca duplicado por documento"— convivan sin una columna
 * nueva. Ver `avisarConceptosPendientes` en el worker.
 */
export async function sendReviewNeededEmail(params: {
  companyId: string;
  locale: 'es' | 'en';
  /** El documento al que se le atribuye ESTE envío (para `notifications` y la idempotencia). */
  documentId: string;
  /** Todos los archivos que el correo menciona, en el orden en que se cargaron. */
  archivos: string[];
  /** Conceptos contestables sumados de todos ellos. Es lo que el cliente va a ver. */
  conceptos: number;
  recipientEmail: string;
  ctaUrl: string;
}): Promise<void> {
  const t = TEMPLATES[params.locale].reviewNeeded({
    archivos: params.archivos,
    conceptos: params.conceptos,
    ctaUrl: params.ctaUrl,
  });
  await enqueueEmail({
    companyId: params.companyId,
    kind: 'review_needed',
    refId: params.documentId,
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

/**
 * Correos de plataforma (sin empresa). Solo Resend + Sentry: la tabla `notifications` es
 * tenant-scoped y no hay fila que anotar. El lead YA está en `demo_requests`; este envío es
 * el aviso encima.
 */
export async function deliverPlatformEmail(payload: EmailSendPayload): Promise<void> {
  if (!resend) {
    reportarFalloDeEnvio(payload, 'RESEND_API_KEY not configured');
    return;
  }
  const result = await resend.emails.send({
    from: env.resendFromEmail,
    to: payload.recipientEmail,
    subject: payload.subject,
    html: payload.html,
  });
  if (result.error) reportarFalloDeEnvio(payload, result.error.message);
}

/**
 * Called only by the email.send worker for correos CON empresa.
 * Los de plataforma (`companyId: null`) van por `deliverPlatformEmail`.
 */
export async function deliverEmail(db: DB, payload: EmailSendPayload): Promise<void> {
  if (payload.companyId == null) {
    throw new Error('deliverEmail requiere companyId; use deliverPlatformEmail');
  }
  const companyId = payload.companyId;
  if (payload.kind === 'demo_request') {
    throw new Error('demo_request no escribe notifications; use deliverPlatformEmail');
  }
  const kind = payload.kind;

  if (!resend) {
    // No RESEND_API_KEY in this environment — record the attempt as failed rather
    // than silently pretending it sent, so notifications/monitoring stays honest.
    const motivo = 'RESEND_API_KEY not configured';
    await db.insert(notifications).values({
      companyId,
      kind,
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
    companyId,
    kind,
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

/**
 * Aviso al equipo de una solicitud de demo. Best-effort: la fila ya está guardada; si esto
 * falla, el panel sigue mostrando el lead.
 */
export async function sendDemoRequestNotice(params: {
  locale: 'es' | 'en';
  requestId: string;
  recipientEmail: string;
  nombre: string;
  empresa: string;
  correo: string;
  telefono: string;
  mensaje: string;
}): Promise<void> {
  const panelUrl = `${env.appBaseUrl.replace(/\/$/, '')}/admin/demo-requests`;
  const t = TEMPLATES[params.locale].demoRequest({
    nombre: params.nombre,
    empresa: params.empresa,
    correo: params.correo,
    telefono: params.telefono,
    mensaje: params.mensaje,
    panelUrl,
  });
  await enqueueEmail({
    companyId: null,
    kind: 'demo_request',
    refId: params.requestId,
    recipientEmail: params.recipientEmail,
    subject: t.subject,
    html: t.html,
  });
}
