import { Elysia } from 'elysia';
import { env } from '@/lib/env';
import { health } from '@/modules/health';

// Macha Finance backend — Bun + Elysia. Tenant scoping is enforced in guards/derive
// (see src/guards/). Admin is a separate namespace. Validation uses TypeBox (Elysia).
export const app = new Elysia()
  .use(health)
  .get('/', () => ({ service: 'macha-backend', env: env.nodeEnv }))
  .listen(env.port);

console.log(`macha-backend listening on :${env.port}`);
export type App = typeof app;
