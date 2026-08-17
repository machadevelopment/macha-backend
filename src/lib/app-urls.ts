import { env } from './env';

/**
 * CU-868kh8jjy: constructores de URLs de la app cliente (macha-frontend), en un solo
 * lugar. Antes cada emisor de email armaba su propio template string, y así se coló el
 * bug que originó este módulo: `lib/reports.ts` enlazaba a `/reports/{reportVersionId}`
 * cuando la ruta `/reports/[id]` resuelve un `reports.id` — todo email de "reporte
 * listo" caía en un 404.
 *
 * La defensa real no es este archivo por sí solo, sino que el nombre del parámetro
 * diga qué id espera (`reportId`, no `id`), y que exista un test que fije la forma de
 * cada ruta. Un template string suelto no tiene ninguna de las dos.
 *
 * REGLA: toda ruta declarada aquí debe existir en macha-frontend/app. Si agregas una,
 * verifica el archivo `page.tsx` correspondiente antes.
 */

/** Detalle de un reporte. Ruta: `app/(app)/reports/[id]/page.tsx` → `GET /reports/:id`,
 * que consulta `reports.id`. Espera el id del REPORTE, nunca el de una versión. */
export function reportUrl(reportId: string): string {
  return `${env.appBaseUrl}/reports/${reportId}`;
}

/** Detalle de una alerta disparada. Espera `alert_events.id`.
 *
 * La ruta `app/(app)/alerts/[id]/page.tsx` y su endpoint `GET /alerts/:id`
 * (`modules/alerts`) existen desde CU-868kh8jxf — el link ya no cae en un 404. */
export function alertUrl(alertEventId: string): string {
  return `${env.appBaseUrl}/alerts/${alertEventId}`;
}

/** Aceptación de una invitación de equipo (CU-868kh8pwv). Espera el token EN CLARO, no
 * el id de la invitación: la base solo guarda su hash, y el enlace es lo único que
 * prueba que quien lo abre recibió el correo. Ruta:
 * `app/(app)/invitations/accept/page.tsx`. */
export function invitationAcceptUrl(token: string): string {
  return `${env.appBaseUrl}/invitations/accept?token=${encodeURIComponent(token)}`;
}

/**
 * Paso de configuración de archivos tras el alta (CU-868krmrcj fase C). Ruta:
 * `app/onboarding/page.tsx` — fuera del grupo `(app)`, es pantalla de vitrina.
 *
 * ENTRA A ESTE MÓDULO PORQUE YA COMETIÓ EL ERROR QUE ESTE MÓDULO EXISTE PARA EVITAR. El
 * `successUrl` del checkout era un template string suelto en `modules/billing/register.ts`
 * apuntando a `/?registered=1`: el cliente terminaba de pagar y aterrizaba en la pantalla
 * de ENTRADA, no dentro del producto. Nadie lo notó porque nada falla — la URL existe, solo
 * que no es donde debía llegar. Es exactamente la forma del bug de `/reports/{versionId}`
 * que originó este archivo.
 *
 * `registered=1` se conserva para que la pantalla pueda distinguir "vengo de pagar" de
 * "entré por el flujo sin cobro", aunque hoy todavía no lo use.
 */
export function onboardingUrl(params: { fromCheckout?: boolean } = {}): string {
  return params.fromCheckout
    ? `${env.appBaseUrl}/onboarding?registered=1`
    : `${env.appBaseUrl}/onboarding`;
}
