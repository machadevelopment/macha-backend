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
 * ⚠️ La ruta `/alerts/[id]` NO existe todavía en el frontend — se construye en
 * CU-868kh8jxf. Hasta que exista, este link resuelve a un 404. Se deja declarado aquí
 * (en vez de un template string enterrado en `alerts.ts`) precisamente para que la
 * dependencia sea visible y no vuelva a perderse de vista. */
export function alertUrl(alertEventId: string): string {
  return `${env.appBaseUrl}/alerts/${alertEventId}`;
}
