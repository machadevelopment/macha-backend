import { eq } from 'drizzle-orm';
import { registerWorker, QUEUES } from '@/queue';
import { reports } from '@/db/schema';
import { withCompanyScope } from '@/lib/db-scope';
import { generateReport } from '@/lib/reports';
import { normalizeSections, type ReportType } from '@/lib/report-sections';

/**
 * CU-868kfvacg/868kfvacr: el reporte de UNA empresa por job.
 *
 * Dos productores desde CU-B2-QA-20260811: el fan-out del tick diario (report-tick.ts) y
 * el endpoint a demanda (`POST /reports/generate`). Los campos nuevos son TODOS opcionales
 * a propósito — un job encolado con el payload viejo justo antes del despliegue tiene que
 * seguir corriendo, y `generateReport` ya toma por defecto exactamente el comportamiento
 * anterior.
 *
 * `sections` se vuelve a normalizar aquí aunque el endpoint ya lo hizo: el payload de un
 * job es un JSON en una tabla, no una entrada validada por TypeBox, y esto corre con
 * privilegios de servidor sobre el ledger de una empresa. Normalizar dos veces cuesta un
 * filtro sobre seis literales.
 */
type ReportGeneratePayload = {
  companyId: string;
  periodStart: string;
  periodEnd: string;
  frequency: 'daily' | 'weekly' | 'on_demand';
  reportId?: string;
  reportType?: ReportType;
  sections?: string[];
  instructions?: string | null;
  debit?: boolean;
  /**
   * CU-868krvuct. Ausente = el idioma de la empresa, que es lo que manda el tick diario:
   * ese reporte no lo pidió ninguna persona. El endpoint a demanda sí lo manda, con el del
   * usuario que lo pidió. Opcional también por compatibilidad, igual que el resto: un job
   * encolado con el payload viejo justo antes del despliegue tiene que seguir corriendo.
   */
  locale?: 'es' | 'en';
};

/**
 * Deja constancia de que la generación falló — CU-868ktkuq0.
 *
 * Sin esto, un reporte fallido y uno que apenas se está generando son indistinguibles: los
 * dos son una fila sin `current_version_id`. La lista tenía que elegir uno de los dos
 * significados para ese caso, y elegía "falló", así que le decía al cliente que su reporte
 * no se generó durante todo el rato que la IA tardaba en escribirlo.
 *
 * SOBRE LOS REINTENTOS: se marca en CADA fallo, no solo cuando se agotan. `job.retryCount`
 * no llega hasta acá —`registerWorker` pasa únicamente `job.data`, a propósito, para que la
 * app no dependa de la forma de pg-boss— y exponerlo por un rótulo de UI sería filtrar el
 * detalle de la cola a las capas de arriba. La consecuencia real es acotada y se corrige
 * sola: un reintento exitoso limpia la marca en el mismo update que escribe la versión
 * (`lib/reports.ts`). El peor caso es un rótulo prematuro por unos minutos; el caso de hoy
 * es un rótulo FALSO en todos los reportes, siempre.
 *
 * No se deja que este UPDATE tape el error: se relanza para que pg-boss registre el fallo y
 * aplique su política de reintentos. Y si marcar falla, gana el error original — perder la
 * causa raíz por un fallo al anotarla sería el peor intercambio posible.
 */
async function marcarFallo(companyId: string, reportId: string): Promise<void> {
  try {
    await withCompanyScope(companyId, (db) =>
      db.update(reports).set({ failedAt: new Date() }).where(eq(reports.id, reportId)),
    );
  } catch (e) {
    console.error(`[report-generate] no se pudo marcar el fallo de ${reportId}:`, e);
  }
}

export function startReportGenerateWorker(): Promise<string> {
  return registerWorker<ReportGeneratePayload>(QUEUES.reportGenerate, async (payload) => {
    const sections = payload.sections ? normalizeSections(payload.sections) : undefined;
    try {
      await withCompanyScope(payload.companyId, (db) =>
        generateReport(db, payload.companyId, {
          periodStart: payload.periodStart,
          periodEnd: payload.periodEnd,
          frequency: payload.frequency,
          reportId: payload.reportId,
          reportType: payload.reportType,
          sections,
          instructions: payload.instructions,
          debit: payload.debit,
          // Se valida igual que `sections`, y por la misma razón: el payload de un job es un
          // JSON en una tabla, no una entrada de TypeBox. Cualquier otro valor se ignora y
          // cae al idioma de la empresa.
          locale: payload.locale === 'es' || payload.locale === 'en' ? payload.locale : undefined,
        }),
      );
    } catch (e) {
      // Solo hay a quién marcarle el fallo si el productor mandó `reportId`. El tick diario
      // no lo manda —crea la fila él mismo dentro de `generateReport`— y en ese caso no hay
      // nada que anotar: el usuario no está esperando una fila concreta en su pantalla.
      if (payload.reportId) await marcarFallo(payload.companyId, payload.reportId);
      throw e;
    }
  });
}
