import { describe, expect, test } from 'bun:test';

// db/client.ts validates DATABASE_URL at import time; postgres.js connects lazily,
// so a syntactically valid but unreachable URL is enough for this smoke test.
process.env.DATABASE_URL ??= 'postgres://smoke:smoke@localhost:5432/smoke';

const { health } = await import('./index');

describe('health module (smoke)', () => {
  test('GET /health responds ok without touching the DB', async () => {
    const res = await health.handle(new Request('http://localhost/health'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok', service: 'macha-backend' });
  });
});
