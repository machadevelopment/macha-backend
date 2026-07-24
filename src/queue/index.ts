import PgBoss from 'pg-boss';
import { env } from '@/lib/env';

/**
 * pg-boss (Postgres-backed jobs) manages its own schema. Excel ingestion is async:
 * one Claude call per sheet -> staging -> internal review -> atomic promotion.
 * The AI queue-depth gate reads pg-boss's own tables (no custom rate-limit table).
 */
export const boss = new PgBoss(env.databaseUrl);

export const QUEUES = {
  excelIngest: 'excel.ingest',
  reportGenerate: 'report.generate',
  alertEvaluate: 'alert.evaluate',
  emailSend: 'email.send',
} as const;

export async function startQueue(): Promise<PgBoss> {
  await boss.start();
  return boss;
}
