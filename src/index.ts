import { Elysia } from 'elysia';
import { env } from '@/lib/env';
import { health } from '@/modules/health';
import { ingestion } from '@/modules/ingestion';
import { startQueue } from '@/queue';
import { startExcelIngestWorker } from '@/queue/workers/excel-ingest';

// Macha Finance backend — Bun + Elysia. Tenant scoping is enforced in guards/derive
// (see src/guards/). Admin is a separate namespace. Validation uses TypeBox (Elysia).
export const app = new Elysia()
  .use(health)
  .use(ingestion)
  .get('/', () => ({ service: 'macha-backend', env: env.nodeEnv }))
  .listen(env.port);

console.log(`macha-backend listening on :${env.port}`);
export type App = typeof app;

// pg-boss workers run in-process with the API for MVP (PRD §5, "workers separables a
// un servicio dedicado por cambio de configuración de despliegue cuando la capacidad
// lo requiera"). Started after the HTTP server so a boss connection failure doesn't
// prevent health checks from at least starting to answer.
startQueue()
  .then(() => startExcelIngestWorker())
  .catch((err) => {
    console.error('startQueue/startExcelIngestWorker failed:', err);
  });
