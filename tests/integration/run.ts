/**
 * Runner de los tests de integración (CU-868kh8zbj).
 *
 * Hace las dos cosas que deben pasar ANTES de que `bun test` toque nada, en el mismo
 * orden que el despliegue real documentado en `0010_force_rls_and_app_role.sql`:
 *
 *   1. aplica todas las migraciones con el rol dueño;
 *   2. crea `macha_app` y re-aplica las migraciones, porque el bloque GRANT/REVOKE de
 *      0010 solo surte efecto una vez que el rol existe (antes es un no-op con NOTICE).
 *
 * Ese segundo pase no es un detalle de test: es el paso que un operador tiene que
 * ejecutar en Railway y el que, si se olvida, deja las garantías de append-only sin
 * efecto. Aquí queda ejercitado en cada corrida.
 *
 * Es un script y no un `beforeAll` global porque `bun test` no garantiza qué archivo
 * corre primero, y los tres archivos necesitan la base ya montada.
 */
import { setupTestDatabase, testOwnerUrl, testAppUrl } from './setup';

async function applyMigrations(): Promise<void> {
  const proc = Bun.spawn(['bun', 'run', 'src/db/migrate.ts'], {
    env: { ...process.env, DATABASE_URL: testOwnerUrl },
    stdout: 'pipe',
    stderr: 'inherit',
  });
  const code = await proc.exited;
  if (code !== 0) throw new Error(`las migraciones fallaron (exit ${code})`);
}

console.log('· aplicando migraciones con el rol dueño');
await applyMigrations();

console.log('· creando el rol macha_app (no dueño, NOSUPERUSER, NOBYPASSRLS)');
await setupTestDatabase();

console.log('· re-aplicando migraciones para activar el GRANT/REVOKE de 0010');
await applyMigrations();

console.log('· corriendo los tests de integración\n');
const tests = Bun.spawn(['bun', 'test', 'tests/integration'], {
  env: { ...process.env, DATABASE_URL: testOwnerUrl, APP_DATABASE_URL: testAppUrl },
  stdout: 'inherit',
  stderr: 'inherit',
});
process.exit(await tests.exited);
