import { eq } from 'drizzle-orm';
import { registerWorker, enqueue, QUEUES } from '@/queue';
import { db } from '@/db/client';
import { companies } from '@/db/schema';
import { planScheduledReports } from '@/lib/report-schedule';

/**
 * CU-868kfvacg: fan-out del tick programado (cron `0 6 * * *`, ver `queue/index.ts`).
 *
 * CU-868kjc7t0 retira la simplificación que este archivo documentaba: ya NO se genera un
 * reporte `'daily'` para cada empresa activa todos los días. Ahora existe
 * `companies.report_frequency` (migración 0023) y el tick sigue despertando a diario pero
 * solo encola a las empresas a las que les toca en esa corrida:
 *
 *   - `daily`  → todos los días, cubriendo el día calendario anterior.
 *   - `weekly` → solo los lunes (UTC), cubriendo la semana calendario anterior completa.
 *   - `off`    → nunca.
 *
 * La decisión de a quién le toca vive entera en `lib/report-schedule.ts`, que es una
 * función pura y está probada con las tres frecuencias en el mismo día. Aquí solo queda la
 * consulta y el bucle de encolado.
 */
export function startReportTickWorker(): Promise<string> {
  return registerWorker(QUEUES.reportTick, async () => {
    // Se leen también las empresas en `off`: filtrar por frecuencia en el SQL duplicaría en
    // otro lenguaje la regla que ya vive —y se prueba— en `planScheduledReports`, y son
    // decenas de filas, no un ledger. `status = 'active'` sí se filtra aquí porque no es
    // una regla de frecuencia: una empresa suspendida no recibe nada, punto.
    const activeCompanies = await db
      .select({ id: companies.id, reportFrequency: companies.reportFrequency })
      .from(companies)
      .where(eq(companies.status, 'active'));

    for (const job of planScheduledReports(activeCompanies, new Date())) {
      // Sin `checkQueueGate`, a propósito (CU-868kjby4z): el gate existe para que un
      // usuario no sature su propia cola, y aquí el que encola es el sistema. Rechazar
      // dejaría a la empresa sin el reporte de su período sin que nadie lo pidiera.
      await enqueue(QUEUES.reportGenerate, job);
    }
  });
}
