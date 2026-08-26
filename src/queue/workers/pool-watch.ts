import * as Sentry from '@sentry/bun';
import { boss, QUEUES } from '@/queue';
import { medirSaludDelPool, describirSalud } from '@/lib/db-health';

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * AVISAR DEL POOL ANTES DE QUE EL USUARIO LO NOTE (caída del 2026-08-26)
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *
 * Aquella caída duró una hora, y no porque fuera difícil de arreglar —fue un comando— sino
 * porque nada la estaba mirando: se descubrió por un reclamo del dueño del producto. Y
 * `GET /health` devolvió 200 en las 20 llamadas que se le hicieron durante la caída, así que
 * sirvió para descartar el backend justo cuando el backend era el problema.
 *
 * ═══ CADA 2 MINUTOS, Y POR QUÉ NO MÁS SEGUIDO NI MENOS ═══
 *
 * El watchdog de `db-scope` cierra una fuga en 90 s y Postgres en 60 s, así que una fuga que
 * se resuelve sola ya se fue cuando este job mira: **lo que este job caza es lo que esas dos
 * redes NO alcanzaron**, o sea el caso grave. Cada 2 minutos da como mucho ~4 minutos de
 * ceguera, que es el orden de lo tolerable para algo que ya no se cura solo. Más seguido no
 * agrega —la señal cambia en minutos— y menos seguido nos devuelve a descubrirlo por reclamo.
 *
 * ═══ `warning` Y NO `captureException` ═══
 *
 * Mismo criterio que el aviso de disco en `db-backup`: esto no es una excepción, es una
 * medición que cruzó un umbral. Mandarlo como error mezcla "algo se rompió" con "algo se está
 * rompiendo", y el segundo es el que da tiempo de actuar.
 *
 * ⚠️ SIN `SENTRY_DSN` ESTO SOLO ESCRIBE EN EL LOG. `index.ts` ya grita al arrancar que la
 * variable no está en producción; mientras siga así, este job detecta y **nadie recibe nada**
 * — los logs de Railway no agregan, no alertan y rotan. La detección está construida; el canal
 * de aviso es una variable de entorno que falta.
 *
 * ═══ NO INTENTA ARREGLARLO, Y ES DELIBERADO ═══
 *
 * Podría matar la transacción colgada. No lo hace: `pg_terminate_backend` desde un job
 * automático es un martillo apuntando a la base de clientes reales, y las dos redes de arriba
 * ya cubren el caso normal. Si algo llegó hasta acá es porque se salió de lo previsto, y ahí
 * quiero una persona mirando, no otro proceso escribiendo.
 */
export function startPoolWatchWorker(): Promise<string> {
  return boss.work(QUEUES.poolWatch, async () => {
    try {
      const salud = await medirSaludDelPool();
      if (!salud.requiereAtencion) return;

      const mensaje = `[pool-watch] el pool de la base necesita atención: ${describirSalud(salud)}`;
      console.error(mensaje);
      Sentry.captureMessage(mensaje, 'warning');
    } catch (err) {
      /*
       * Un fallo al MEDIR no puede tumbar el job, y menos reintentarse en bucle: si la base no
       * responde, este job es el que menos importa de los que están fallando.
       */
      console.error('[pool-watch] no se pudo medir la salud del pool:', err);
    }
  });
}
