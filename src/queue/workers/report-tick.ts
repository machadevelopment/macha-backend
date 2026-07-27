import { eq } from 'drizzle-orm';
import { registerWorker, enqueue, QUEUES } from '@/queue';
import { db } from '@/db/client';
import { companies } from '@/db/schema';

/**
 * CU-868kfvacg: fan-out diario. No existe todavía un campo de preferencia de
 * frecuencia por empresa (companies no tiene reportFrequency; reports.frequency solo
 * registra con qué frecuencia se generó CADA reporte ya creado) — ese campo es
 * alcance de F7 (onboarding/ajustes de empresa), no construido todavía. Simplificación
 * documentada: por ahora el tick genera un reporte 'daily' para cada empresa activa,
 * todos los días, cubriendo el día calendario anterior.
 */
export function startReportTickWorker(): Promise<string> {
  return registerWorker(QUEUES.reportTick, async () => {
    const activeCompanies = await db.select({ id: companies.id }).from(companies).where(eq(companies.status, 'active'));

    const yesterday = new Date();
    yesterday.setUTCDate(yesterday.getUTCDate() - 1);
    const period = yesterday.toISOString().slice(0, 10);

    for (const company of activeCompanies) {
      await enqueue(QUEUES.reportGenerate, {
        companyId: company.id,
        periodStart: period,
        periodEnd: period,
        frequency: 'daily' as const,
      });
    }
  });
}
