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
import postgres from 'postgres';
import { setupTestDatabase, testOwnerUrl, testAppUrl } from './setup';

/**
 * Base limpia en cada corrida. El compose no monta volumen, pero eso solo garantiza
 * el borrado cuando el contenedor se recrea — al correr dos veces seguidas contra el
 * mismo contenedor (o contra un Postgres local), los seeds de `beforeAll` chocaban
 * con las constraints UNIQUE de la corrida anterior y los tests fallaban en el hook,
 * no en la aserción. Un test de aislamiento que arrastra datos previos no prueba lo
 * que dice probar.
 */
async function resetSchema(): Promise<void> {
  const owner = postgres(testOwnerUrl, { max: 1, onnotice: () => {}, connect_timeout: 10 });
  try {
    await owner.unsafe('drop schema if exists public cascade; create schema public;');
  } finally {
    await owner.end();
  }
}

async function applyMigrations(): Promise<void> {
  // stdout heredado, NO 'pipe': un pipe que nadie drena puede bloquear al hijo cuando
  // se llena, y `await proc.exited` no resuelve nunca. Además queremos la salida de
  // las migraciones en el log de CI para poder diagnosticar sin adivinar.
  const proc = Bun.spawn(['bun', 'run', 'src/db/migrate.ts'], {
    env: { ...process.env, DATABASE_URL: testOwnerUrl },
    stdout: 'inherit',
    stderr: 'inherit',
  });
  const code = await proc.exited;
  if (code !== 0) throw new Error(`las migraciones fallaron (exit ${code})`);
}

console.log('· reseteando el esquema public (base limpia en cada corrida)');
await resetSchema();

console.log('· aplicando migraciones con el rol dueño');
await applyMigrations();

console.log('· creando el rol macha_app (no dueño, NOSUPERUSER, NOBYPASSRLS)');
await setupTestDatabase();

console.log('· re-aplicando migraciones para activar el GRANT/REVOKE de 0010');
await applyMigrations();

console.log('· corriendo los tests de integración\n');
// `--preload teardown.ts`: cierra el pool compartido de src/db/client.ts UNA vez al
// final. Antes cada archivo lo cerraba en su propio afterAll y, como bun test corre
// todo en el mismo proceso, el primero en terminar dejaba sin conexión a los demás
// (CU-868kjc4wa).
const tests = Bun.spawn(
  ['bun', 'test', '--preload', './tests/integration/teardown.ts', 'tests/integration'],
  {
    env: { ...process.env, DATABASE_URL: testOwnerUrl, APP_DATABASE_URL: testAppUrl },
    stdout: 'inherit',
    stderr: 'inherit',
  },
);
process.exit(await tests.exited);
