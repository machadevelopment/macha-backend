import * as Sentry from '@sentry/bun';
import { registerWorker, QUEUES } from '@/queue';
import { runDatabaseBackup } from '@/lib/backups';

/**
 * CU-868kfvar3: pg_dump nocturno -> S3, segunda capa de respaldo aparte del backup
 * nativo de Railway. Sin alerta a Sentry el fallo pasaría desapercibido hasta el
 * simulacro de restauración mensual (CU-868kfvata) — demasiado tarde para un backup
 * que debía correr todas las noches.
 */
export function startDbBackupWorker(): Promise<string> {
  return registerWorker(QUEUES.dbBackup, async () => {
    try {
      const { key, sizeBytes } = await runDatabaseBackup();
      console.log(`db-backup: uploaded ${key} (${sizeBytes} bytes)`);
    } catch (err) {
      Sentry.captureException(err);
      throw err;
    }
  });
}
