import PgBoss from 'pg-boss';
import { env } from '@/lib/env';

/**
 * pg-boss (Postgres-backed jobs) manages its own schema. Excel ingestion is async:
 * one Claude call per sheet -> staging -> internal review -> atomic promotion.
 * The AI queue-depth gate reads pg-boss's own tables (no custom rate-limit table).
 *
 * CU-868kfva8k: the app talks to `enqueue`/`registerWorker` below, never to `boss`
 * directly outside this file — that's the internal queue interface, ready to swap
 * pg-boss out later without touching call sites.
 */
// `schedule: true` enables pg-boss's own cron subsystem (CU-868kfvacg's daily tick) —
// off by default in the string-only constructor form.
export const boss = new PgBoss({ connectionString: env.databaseUrl, schedule: true });

export const QUEUES = {
  excelIngest: 'excel.ingest',
  /**
   * Reintento de la promoción de un documento que ya está en `review`, disparado cuando
   * staff resuelve su última fila pendiente. Va por cola y no por llamada directa desde la
   * ruta admin por una razón estructural, no de estilo: `promoteDocument` escribe en
   * `transactions`/`invoices`/`bills`, que son tenant-scoped con RLS y `FORCE ROW LEVEL
   * SECURITY`, y necesita la conexión reservada con el GUC `app.company_id` puesto
   * (`withCompanyScope`). El namespace `/admin/*` está estructuralmente FUERA de esa
   * cadena de guards (CLAUDE.md), así que desde ahí esos INSERT no tienen dónde escribir.
   */
  documentPromote: 'document.promote',
  reportTick: 'report.tick',
  reportGenerate: 'report.generate',
  alertEvaluate: 'alert.evaluate',
  emailSend: 'email.send',
  dbBackup: 'db.backup',
  /** Vigilancia del pool de conexiones — ver `queue/workers/pool-watch.ts`. */
  poolWatch: 'db.pool-watch',
} as const;

export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

// Retry policy per queue (PRD §8 "Fallos de job"): ingesta -> reintento -> cola de
// revisión humana (staging_rows ya marca lo dudoso, así que agotar reintentos aquí
// simplemente deja el job en 'failed' para que staff lo vea en el monitoreo de
// uploads); reportes -> según causa, reintentos moderados; alertas -> reintento
// estándar sin backoff (evaluación barata, determinista); email -> reintentos con
// backoff (fallos transitorios de Resend).
//
// `expireInSeconds` NO es opcional para los jobs largos, aunque parezca un detalle: el
// default de pg-boss son 15 minutos (`expire_in interval not null default interval '15
// minutes'`, src/plans.js) y ninguna cola lo declaraba. Pasados esos 15 minutos pg-boss
// da el job por vencido y lo reencola — pero el worker de este proceso SIGUE corriendo,
// porque expirar es una marca en la tabla, no una cancelación. El resultado observado en
// producción (documento `ce2a824b`, 2026-08-06) es un archivo que se queda en
// `processing` para siempre desde la vista del cliente: la ejecución que lo terminaría ya
// no es la dueña del job, y la que sí lo es arranca de nuevo.
//
// Es un fallo de configuración de cola, no del worker: el `catch` del worker sí marca
// `failed`, pero solo si algo lanza. Un vencimiento no lanza nada.
export const RETRY_POLICY: Record<QueueName, PgBoss.SendOptions> = {
  //
  // Una hora, y el número sale de medir, no de redondear. En producción una hoja ancha
  // ("Info MACRO 2026", ~587 columnas) se parte en lotes de 8 filas porque el
  // presupuesto de salida manda (lib/sheet-batching.ts), y una hoja normal de 85 filas
  // por lote tardó entre 140 y 220 segundos por llamada a Claude. Un libro de varias
  // hojas pasa de 15 minutos con facilidad — el que motivó esto llevaba 24 lotes en 11
  // minutos y no había terminado.
  //
  // No cubre el tope teórico del intake (50.000 filas: a este ritmo son horas). Eso NO se
  // arregla subiendo más este número, se arregla dejando de procesar los lotes en serie;
  // queda como trabajo aparte. Una hora cubre con margen el archivo de una PYME real, que
  // es lo que hoy se rompe.
  [QUEUES.excelIngest]: {
    retryLimit: 3,
    retryDelay: 30,
    retryBackoff: true,
    expireInSeconds: 3_600,
  },
  // Promover no llama a Claude: es un INSERT masivo dentro de una transacción. Lo que
  // puede tardar es el volumen (un libro de miles de filas) y lo que puede fallar es
  // transitorio (contención de locks con otra promoción del mismo tenant). Diez minutos
  // cubren con holgura el archivo de una PYME; 3 reintentos porque el modo de fallo real
  // —falta la tasa de cambio— es DETERMINISTA y reintentarlo no lo arregla: agota los
  // intentos y deja el job `failed` para que se vea en el monitoreo, que es exactamente lo
  // que se quiere de un fallo que necesita a un humano.
  [QUEUES.documentPromote]: {
    retryLimit: 3,
    retryDelay: 30,
    retryBackoff: true,
    expireInSeconds: 600,
  },
  [QUEUES.reportTick]: { retryLimit: 1, retryDelay: 60, retryBackoff: false },
  // Generar un reporte es UNA llamada a Claude, no una por lote, pero con narrativa larga
  // y render; 15 minutos es ajustado y el modo de fallo sería el mismo silencio.
  [QUEUES.reportGenerate]: {
    retryLimit: 2,
    retryDelay: 60,
    retryBackoff: true,
    expireInSeconds: 900,
  },
  [QUEUES.alertEvaluate]: { retryLimit: 3, retryDelay: 15, retryBackoff: false },
  [QUEUES.emailSend]: { retryLimit: 3, retryDelay: 30, retryBackoff: true },
  // Backup fallido -> reintenta pronto en vez de esperar 24h a la próxima noche. El
  // `pg_dump` de una base que crece puede pasarse de 15 minutos y quedar en el mismo
  // limbo; media hora da margen sin dejar un job colgado indefinidamente.
  /*
   * El valor es INDIFERENTE en la práctica y se pone en 1 para no debilitar la garantía que
   * `retry-policy.test.ts` protege (toda cola con un techo explícito de reintentos).
   *
   * Es indiferente porque `pool-watch` captura sus propios errores y nunca lanza: pg-boss no
   * ve un fallo, así que no hay nada que reintentar. Y si algún día lanzara, la medición de
   * dentro de dos minutos la reemplaza — una vigilancia que se reintenta solo agrega ruido
   * cuando la base ya está en problemas.
   */
  [QUEUES.poolWatch]: { retryLimit: 1, retryDelay: 30, retryBackoff: false },
  [QUEUES.dbBackup]: {
    retryLimit: 2,
    retryDelay: 300,
    retryBackoff: true,
    expireInSeconds: 1_800,
  },
};

export async function startQueue(): Promise<PgBoss> {
  await boss.start();
  for (const queue of Object.values(QUEUES)) {
    await boss.createQueue(queue);
  }
  // Daily fan-out trigger (CU-868kfvacg) — 06:00 UTC, one singleton tick that queries
  // which companies are due and enqueues report.generate per company.
  await boss.schedule(QUEUES.reportTick, '0 6 * * *');
  // Nightly pg_dump -> S3 (CU-868kfvar3), 07:00 UTC — after the report tick so the
  // two don't contend for DB read load in the same minute.
  await boss.schedule(QUEUES.dbBackup, '0 7 * * *');
  // Cada 2 minutos: caza lo que el watchdog (90 s) y Postgres (60 s) no alcanzaron.
  await boss.schedule(QUEUES.poolWatch, '*/2 * * * *');
  return boss;
}

/**
 * The only way the app enqueues jobs (CU-868kfva8k). Applies the queue's retry
 * policy by default; pass `opts` to override per-call when a job genuinely needs it.
 */
export async function enqueue<T extends object>(
  queue: QueueName,
  payload: T,
  opts?: PgBoss.SendOptions,
): Promise<string | null> {
  return boss.send(queue, payload, { ...RETRY_POLICY[queue], ...opts });
}

/**
 * The only way the app registers a worker (CU-868kfva8k). `handler` is called once
 * per job with its typed payload; a thrown error triggers pg-boss's own retry
 * (per RETRY_POLICY) and, once exhausted, leaves the job as 'failed' for staff to see.
 */
export async function registerWorker<T extends object>(
  queue: QueueName,
  handler: (payload: T) => Promise<void>,
  opts?: PgBoss.WorkOptions,
): Promise<string> {
  return boss.work<T>(queue, opts ?? {}, async (jobs) => {
    for (const job of jobs) {
      await handler(job.data);
    }
  });
}
