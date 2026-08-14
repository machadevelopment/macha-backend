/**
 * Las migraciones tienen que poder reaplicarse CON TRÁFICO VIVO ENCIMA.
 *
 * ═══ EL FALLO REAL QUE ESTO REPRODUCE (producción, 2026-08-14) ═══
 *
 * Un deploy que solo cambiaba documentación falló así:
 *
 *   PostgresError: deadlock detected
 *   where: SQL statement "ALTER TABLE company_users FORCE ROW LEVEL SECURITY;"
 *   error: script "db:migrate" exited with code 1
 *
 * `migrate.ts` reaplica todos los archivos en cada deploy, y ocho de ellos emitían
 * `ALTER TABLE ... ENABLE/FORCE ROW LEVEL SECURITY` sin preguntar si ya estaba puesto —
 * un AccessExclusiveLock sobre ~23 tablas de producción, cada vez, para no cambiar nada.
 * Al mismo tiempo el contenedor VIEJO seguía sirviendo y tenía AccessShareLock sobre esas
 * mismas tablas.
 *
 * Que reventara con un cambio de documentación es justamente el punto: el contenido del
 * deploy no tenía nada que ver. Dependía de si en ese instante había una request viva.
 *
 * ═══ POR QUÉ EL TEST TIENE ESTA FORMA ═══
 *
 * La única manera de probarlo es la que lo rompió: sostener una transacción abierta sobre
 * `company_users` —que es exactamente lo que hace una request normal— y correr las
 * migraciones encima. Sin el arreglo esto se queda esperando el lock y muere por
 * `lock_timeout`; con el arreglo ni lo pide, porque RLS ya está aplicado.
 *
 * Un test que solo corriera las migraciones dos veces PASARÍA sin el arreglo: sin nadie
 * sosteniendo un lock, el ALTER redundante se consigue al instante. El tráfico concurrente
 * no es decoración del test, es la condición que revela el fallo.
 */
import { afterAll, expect, test } from 'bun:test';
import postgres from 'postgres';
import { testOwnerUrl } from './setup';

const sql = postgres(testOwnerUrl, { max: 2, onnotice: () => {}, connect_timeout: 10 });
afterAll(async () => {
  await sql.end();
});

async function correrMigraciones(): Promise<number> {
  const proc = Bun.spawn(['bun', 'run', 'src/db/migrate.ts'], {
    env: { ...process.env, DATABASE_URL: testOwnerUrl },
    stdout: 'inherit',
    stderr: 'inherit',
  });
  return await proc.exited;
}

test('las migraciones se reaplican con una transacción viva sobre company_users', async () => {
  /*
   * `SELECT ... FOR SHARE` no: eso sería un lock de FILA. Lo que toma una request normal es
   * AccessShareLock sobre la TABLA, que es con lo que choca un ALTER TABLE, y un SELECT
   * cualquiera dentro de una transacción abierta ya lo sostiene.
   */
  const codigo = await sql.begin(async (tx) => {
    await tx.unsafe('SELECT id FROM company_users LIMIT 1');
    // La transacción sigue abierta mientras corre el subproceso: el lock está tomado.
    return await correrMigraciones();
  });

  expect(codigo).toBe(0);
  // Timeout explícito: aplicar TODAS las migraciones pasa de los 5 s por defecto de
  // `bun test`, y al vencerse mata el subproceso con SIGTERM — que se lee como exit 143 y
  // parece el fallo que el test busca. Un test que falla por su propio reloj no prueba nada.
}, 120_000);

test('el estado de RLS sigue siendo el correcto después de reaplicar', async () => {
  /*
   * El riesgo del arreglo es el opuesto al del fallo: una guarda mal escrita se salta el
   * ALTER cuando SÍ hacía falta y deja el backstop apagado en silencio. Se comprueban las
   * dos banderas juntas porque `ENABLE` no aplica al DUEÑO de la tabla — una tabla con
   * ENABLE y sin FORCE tiene el backstop muerto justo para el rol que corre las migraciones.
   */
  const filas = await sql.unsafe<{ relname: string; enabled: boolean; forced: boolean }[]>(`
    SELECT c.relname,
           c.relrowsecurity      AS enabled,
           c.relforcerowsecurity AS forced
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relkind IN ('r', 'p')
       AND c.relname IN ('transactions','invoices','bills','company_users','documents',
                         'staging_rows','ai_usage_events','subscriptions','payments',
                         'inventory_items','inventory_movements','ingested_rows',
                         'company_invitations','document_ingest_batches')
     ORDER BY c.relname
  `);

  expect(filas.length).toBeGreaterThan(0);
  const flojas = filas.filter((f) => !f.enabled || !f.forced).map((f) => f.relname);
  expect(flojas).toEqual([]);
});
