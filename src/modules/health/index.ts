import { Elysia } from 'elysia';
import { sql } from '@/db/client';

export const health = new Elysia({ prefix: '/health' })
  .get('/', () => ({ status: 'ok', service: 'macha-backend' }))
  .get('/db', async () => {
    const [row] = await sql`SELECT 1 AS ok`;
    return { db: row?.ok === 1 ? 'ok' : 'error' };
  });
