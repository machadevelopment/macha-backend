import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

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

  test('una fuga del pool no pone 503 en /health/db — eso bloquea el deploy del arreglo', () => {
    const src = readFileSync(join(import.meta.dir, 'index.ts'), 'utf-8');
    const db = src.slice(src.indexOf(".get('/db'"));
    const desdeAtencion = db.indexOf('requiereAtencion');
    const hastaCatch = db.indexOf('} catch');
    const bloque = db.slice(desdeAtencion, hastaCatch);
    expect(bloque).toContain('atencion:');
    expect(bloque).not.toContain('set.status');
  });
});
