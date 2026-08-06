import { describe, expect, test, beforeAll, afterAll } from 'bun:test';
import { setupTestDatabase, appConnection, ownerConnection } from './setup';

/**
 * CU-868kh8zbj criterio 6. Estos tests no prueban una feature: prueban la
 * PRECONDICIÓN de la que dependen todos los demás.
 *
 * Si el rol con el que la app conecta resulta ser el dueño de las tablas —o un
 * superusuario, o tiene BYPASSRLS— entonces RLS y `REVOKE UPDATE,DELETE` son no-ops
 * para la app, y los tests de aislamiento y append-only pasarían en verde sin estar
 * probando absolutamente nada. Eso es peor que no tenerlos: da confianza falsa.
 *
 * `env.appDatabaseUrl` cae a `DATABASE_URL` cuando `APP_DATABASE_URL` no está seteada
 * (ver src/lib/env.ts), y ese fallback es exactamente el escenario que aquí se
 * bloquea para el entorno de test.
 */
describe('precondiciones del rol de aplicación (CU-868kh8zbj)', () => {
  let app: ReturnType<typeof appConnection>;
  let owner: ReturnType<typeof ownerConnection>;

  beforeAll(async () => {
    await setupTestDatabase();
    app = appConnection();
    owner = ownerConnection();
  });

  afterAll(async () => {
    await app?.end();
    await owner?.end();
  });

  test('la app conecta como macha_app, no como el rol dueño', async () => {
    const [{ current_user: appUser }] = await app`select current_user`;
    const [{ current_user: ownerUser }] = await owner`select current_user`;
    expect(appUser).toBe('macha_app');
    expect(appUser).not.toBe(ownerUser);
  });

  test('macha_app no es dueño de ninguna tabla del esquema public', async () => {
    // Postgres da al dueño UPDATE/DELETE implícitos e irrevocables sobre sus tablas.
    // Si esta lista no viniera vacía, el append-only sería decorativo.
    const owned = await app`
      select tablename from pg_tables
      where schemaname = 'public' and tableowner = current_user
    `;
    expect(owned.map((r) => r.tablename)).toEqual([]);
  });

  test('macha_app no es superusuario ni tiene BYPASSRLS', async () => {
    // Cualquiera de las dos haría que RLS se ignore por completo para esta conexión.
    const [role] = await app`
      select rolsuper, rolbypassrls from pg_roles where rolname = current_user
    `;
    expect(role!.rolsuper).toBe(false);
    expect(role!.rolbypassrls).toBe(false);
  });

  test('macha_app puede usar y crear en el esquema pgboss (CU-868kmuheb)', async () => {
    // pg-boss vive en su PROPIO esquema, y 0010 solo concedió sobre `public`. Mientras la
    // app corrió como dueño no se notó; al pasar a `macha_app`, `POST /documents` empezó
    // a devolver 500 con `permission denied for schema pgboss` — y con él TODO lo
    // asíncrono (ingesta, reportes, alertas, correo, respaldo) más el gate de profundidad
    // de cola, que lee `pgboss.job`. Visto en producción el 2026-08-05.
    //
    // CREATE, no solo USAGE: pg-boss instala y migra sus propias tablas al arrancar.
    const [priv] = await app`
      select
        has_schema_privilege(current_user, 'pgboss', 'USAGE')  as can_use,
        has_schema_privilege(current_user, 'pgboss', 'CREATE') as can_create
    `;
    expect({ use: priv!.can_use, create: priv!.can_create }).toEqual({ use: true, create: true });
  });

  test('macha_app lee las tablas que el DUEÑO creó en pgboss (CU-868kmuheb)', async () => {
    // El caso real de producción: las tablas de la cola ya existían, creadas por el dueño
    // cuando la app todavía conectaba como dueño. `has_schema_privilege` sobre el esquema
    // no dice nada de ellas — hacen falta los GRANT sobre las tablas y el ALTER DEFAULT
    // PRIVILEGES para las que vengan después. Se simula creando una tabla con el dueño
    // DESPUÉS de la migración y comprobando que la app la puede tocar.
    await owner`create table if not exists pgboss.grant_probe (id int)`;
    try {
      await app`insert into pgboss.grant_probe (id) values (1)`;
      const rows = await app`select id from pgboss.grant_probe`;
      expect(rows.map((r) => r.id)).toEqual([1]);
      await app`delete from pgboss.grant_probe`;
    } finally {
      await owner`drop table if exists pgboss.grant_probe`;
    }
  });

  test('las tablas de negocio tienen RLS habilitado Y forzado', async () => {
    // ENABLE por sí solo no aplica al dueño (por eso existe la migración 0010).
    // Se comprueban las dos banderas: relrowsecurity y relforcerowsecurity.
    const rows = await owner`
      select relname, relrowsecurity, relforcerowsecurity
      from pg_class
      where relname in (
        'documents', 'ai_usage_events', 'metric_rollups', 'company_users',
        -- Migración 0019. Las tablas nuevas se agregan aquí y no en otra prueba: una
        -- tabla de negocio sin RLS forzado es el mismo agujero se llame como se llame, y
        -- la lista es lo único que hace que una tabla nueva no se quede fuera en silencio.
        'inventory_items', 'inventory_movements'
      )
        and relkind = 'r'
    `;
    expect(rows.length).toBe(6);
    for (const row of rows) {
      expect({
        table: row.relname,
        enabled: row.relrowsecurity,
        forced: row.relforcerowsecurity,
      }).toEqual({ table: row.relname, enabled: true, forced: true });
    }
  });
});
