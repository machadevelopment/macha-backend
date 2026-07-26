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
export const boss = new PgBoss(env.databaseUrl);

export const QUEUES = {
  excelIngest: 'excel.ingest',
  reportGenerate: 'report.generate',
  alertEvaluate: 'alert.evaluate',
  emailSend: 'email.send',
} as const;

export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

// Retry policy per queue (PRD §8 "Fallos de job"): ingesta -> reintento -> cola de
// revisión humana (staging_rows ya marca lo dudoso, así que agotar reintentos aquí
// simplemente deja el job en 'failed' para que staff lo vea en el monitoreo de
// uploads); reportes -> según causa, reintentos moderados; alertas -> reintento
// estándar sin backoff (evaluación barata, determinista); email -> reintentos con
// backoff (fallos transitorios de Resend).
const RETRY_POLICY: Record<QueueName, PgBoss.SendOptions> = {
  [QUEUES.excelIngest]: { retryLimit: 3, retryDelay: 30, retryBackoff: true },
  [QUEUES.reportGenerate]: { retryLimit: 2, retryDelay: 60, retryBackoff: true },
  [QUEUES.alertEvaluate]: { retryLimit: 3, retryDelay: 15, retryBackoff: false },
  [QUEUES.emailSend]: { retryLimit: 3, retryDelay: 30, retryBackoff: true },
};

export async function startQueue(): Promise<PgBoss> {
  await boss.start();
  for (const queue of Object.values(QUEUES)) {
    await boss.createQueue(queue);
  }
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
