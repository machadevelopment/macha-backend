import { describe, expect, test } from 'bun:test';

process.env.DATABASE_URL ??= 'postgres://smoke:smoke@localhost:5432/smoke';

const { filterExpired } = await import('./backups');

describe('filterExpired (CU-868kfvar3 — retención de backups en S3)', () => {
  const now = new Date('2026-07-28T00:00:00Z');

  test('mantiene objetos dentro de la ventana de retención', () => {
    const objects = [
      { key: 'backups/postgres/29d-ago.dump', lastModified: new Date('2026-06-29T00:00:00Z') },
    ];
    expect(filterExpired(objects, 30, now)).toEqual([]);
  });

  test('marca como expirado un objeto más viejo que la retención', () => {
    const objects = [
      { key: 'backups/postgres/31d-ago.dump', lastModified: new Date('2026-06-27T00:00:00Z') },
    ];
    expect(filterExpired(objects, 30, now)).toEqual(objects);
  });

  test('filtra solo los expirados en un lote mixto', () => {
    const fresh = { key: 'fresh.dump', lastModified: new Date('2026-07-27T00:00:00Z') };
    const stale = { key: 'stale.dump', lastModified: new Date('2026-05-01T00:00:00Z') };
    expect(filterExpired([fresh, stale], 30, now)).toEqual([stale]);
  });

  test('retención en 0 expira todo lo anterior a "ahora"', () => {
    const objects = [{ key: 'today.dump', lastModified: new Date('2026-07-27T23:00:00Z') }];
    expect(filterExpired(objects, 0, now)).toEqual(objects);
  });
});
