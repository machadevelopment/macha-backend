import * as Sentry from '@sentry/bun';
import { registerWorker, QUEUES } from '@/queue';
import { runDatabaseBackup } from '@/lib/backups';
import { describirTamano, medirTamanoDeBase } from '@/lib/db-size';

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

    /*
     * ═══ Y DE PASO, CUÁNTO ESPACIO QUEDA (incidente del 2026-08-26) ═══
     *
     * La base de producción se cayó por disco lleno y nadie lo supo hasta que Railway mandó
     * el correo de "Deploy Crashed!" — a esa altura la contabilidad de los clientes llevaba
     * una hora inaccesible y el arreglo era manual y de dashboard.
     *
     * Va acá y no en un job propio porque este ya corre todas las noches y ya toca la base:
     * un job nuevo sería una pieza más que mantener para preguntar algo que este ya está en
     * posición de responder.
     *
     * VA DESPUÉS DEL BACKUP Y EN SU PROPIO `try`, y las dos cosas importan. Después, porque
     * el backup es lo que no puede fallar y no debe esperar a un chequeo informativo. En su
     * propio `try`, porque **un fallo midiendo el espacio no puede tumbar el backup de la
     * noche**: sería cambiar un aviso por el respaldo, que es exactamente el peor negocio
     * posible.
     */
    try {
      const tamano = await medirTamanoDeBase();
      const mensaje = `db-size: ${describirTamano(tamano)}`;
      if (tamano.requiereAtencion) {
        console.warn(`⚠️ ${mensaje}`);
        /*
         * `captureMessage` con `warning` y no `captureException`: esto no es un fallo, es un
         * aviso con tiempo de reacción. Mandarlo como excepción lo pondría junto a los errores
         * reales y le enseñaría al equipo a ignorar esa cola.
         */
        Sentry.captureMessage(mensaje, 'warning');
      } else {
        console.log(mensaje);
      }
    } catch (err) {
      console.error('db-backup: no se pudo medir el tamaño de la base (el backup sí corrió):', err);
    }
  });
}
