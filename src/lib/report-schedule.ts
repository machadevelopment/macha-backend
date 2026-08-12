/**
 * Frecuencia de reportes automáticos POR EMPRESA (CU-868kjc7t0).
 *
 * Hasta este ticket no existía: `report-tick.ts` generaba un reporte `'daily'` para CADA
 * empresa activa TODOS los días, la pidiera alguien o no. Cada uno de esos reportes es una
 * llamada a Claude con narrativa larga y un email a todo owner/admin con
 * `receives_reports`, así que la simplificación costaba `empresas_activas × 365` llamadas
 * al año y otros tantos correos no solicitados — justo lo contrario del objetivo del
 * PRD §2 ("costo de IA medible y controlable por empresa") y con US-12 ("se respeta la
 * frecuencia configurada") sin cumplir por no haber nada que configurar.
 *
 * `reports.frequency` NO servía para esto: registra con qué frecuencia se generó cada
 * reporte YA CREADO (histórico), no la preferencia de la empresa. La preferencia vive en
 * `companies.report_frequency` (migración 0023).
 *
 * DEFAULT `weekly`, no `daily`: recibir un correo todos los días es una decisión que el
 * cliente debe tomar activamente, no heredar por omisión.
 *
 * TODO EN UTC, igual que el tick de siempre. El cron corre a las 06:00 UTC
 * (`queue/index.ts`) y `companies` no tiene columna de zona horaria; inventar una aquí
 * sería alcance nuevo. Consecuencia asumida: "el lunes" y "el día anterior" son el lunes y
 * el día anterior en UTC, que para Guatemala (UTC-6) cae a medianoche del domingo.
 */
import { t, type Static } from 'elysia';

/**
 * Catálogo de frecuencias, declarado UNA vez como esquema TypeBox de Elysia (no zod) para
 * que las rutas que lo validan y el tipo de TypeScript no puedan desincronizarse: el tipo,
 * la lista y la validación de entrada salen todos de esta constante.
 */
export const reportFrequencySchema = t.Union([
  t.Literal('daily'),
  t.Literal('weekly'),
  t.Literal('off'),
]);

export type ReportFrequency = Static<typeof reportFrequencySchema>;

export const REPORT_FREQUENCIES = reportFrequencySchema.anyOf.map((f) => f.const);

export const DEFAULT_REPORT_FREQUENCY: ReportFrequency = 'weekly';

/**
 * Día de la semana (UTC, `Date#getUTCDay`) en el que corre el reporte semanal: LUNES.
 * Cubre la semana calendario ANTERIOR completa — lunes a domingo —, que es la única
 * ventana que ya está cerrada cuando el tick despierta el lunes por la mañana.
 */
export const WEEKLY_RUN_UTC_DAY = 1;

export interface CompanyReportPreference {
  id: string;
  reportFrequency: ReportFrequency;
}

export interface ScheduledReportJob {
  companyId: string;
  periodStart: string;
  periodEnd: string;
  /** `off` nunca produce un job, por eso no aparece en el tipo del payload encolado. */
  frequency: 'daily' | 'weekly';
}

function sumarDiasUtc(fecha: Date, dias: number): Date {
  const copia = new Date(fecha.getTime());
  copia.setUTCDate(copia.getUTCDate() + dias);
  return copia;
}

function fechaIso(fecha: Date): string {
  return fecha.toISOString().slice(0, 10);
}

/**
 * Decide QUÉ empresas reciben reporte en esta corrida del tick y sobre qué período.
 *
 * Función pura a propósito: es la regla de negocio entera del ticket y así se puede probar
 * con las tres frecuencias en el mismo día sin Postgres ni pg-boss de por medio
 * (`report-schedule.test.ts`). El worker solo consulta y encola lo que esto devuelve.
 *
 * Cualquier valor no reconocido se trata como `off` — no como el default. Encolar por las
 * dudas gastaría créditos e IA de una empresa por un dato corrupto; no encolar solo la deja
 * sin un reporte que se puede pedir a demanda.
 */
export function planScheduledReports(
  companies: readonly CompanyReportPreference[],
  now: Date,
): ScheduledReportJob[] {
  const ayer = fechaIso(sumarDiasUtc(now, -1));
  const esDiaSemanal = now.getUTCDay() === WEEKLY_RUN_UTC_DAY;
  const inicioSemanaAnterior = fechaIso(sumarDiasUtc(now, -7));

  const jobs: ScheduledReportJob[] = [];
  for (const company of companies) {
    if (company.reportFrequency === 'daily') {
      jobs.push({
        companyId: company.id,
        periodStart: ayer,
        periodEnd: ayer,
        frequency: 'daily',
      });
    } else if (company.reportFrequency === 'weekly' && esDiaSemanal) {
      jobs.push({
        companyId: company.id,
        periodStart: inicioSemanaAnterior,
        periodEnd: ayer,
        frequency: 'weekly',
      });
    }
  }
  return jobs;
}
