import { afterAll } from 'bun:test';

/**
 * Cierre del pool compartido, una sola vez para toda la suite (CU-868kjc4wa).
 *
 * `bun test` corre todos los archivos en el MISMO proceso, así que `src/db/client.ts`
 * —y con él su pool `sql`— se importa una vez y se comparte. Cuando cada archivo hacía
 * su propio `sql.end()` en el `afterAll`, el primero en terminar dejaba el pool cerrado
 * y los siguientes que ejercitaban un guard fallaban con 500. Un fallo dependiente del
 * orden de los archivos, que es la peor clase de test intermitente.
 *
 * Se carga con `--preload` desde `tests/integration/run.ts`: un `afterAll` registrado
 * en un preload aplica a la corrida completa, no a un `describe`.
 */
afterAll(async () => {
  // Import perezoso: si un archivo de test nunca tocó la base, no tiene sentido abrir
  // el pool aquí solo para cerrarlo.
  const { sql } = await import('@/db/client');
  await sql.end();
});
