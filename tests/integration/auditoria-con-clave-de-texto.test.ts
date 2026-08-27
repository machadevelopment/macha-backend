import { describe, expect, test, beforeAll, afterAll } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { ownerConnection, setupTestDatabase } from './setup';

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * AUDITAR UNA TABLA CUYA CLAVE ES TEXTO (bug reportado por Jose, 2026-08-27)
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *
 * Guardar cualquier cambio en `/admin/plans` devolvía "Unexpected server error" y no guardaba
 * nada. `admin_audit_log.target_id` era `uuid` y la ruta le pasa `plans.code` —texto—, así que
 * el insert del registro lanzaba `invalid input syntax for type uuid`. Como corre DENTRO de la
 * transacción de la escritura de negocio, el 500 venía además con el cambio deshecho.
 *
 * Medido en producción antes del arreglo: **cero planes editados alguna vez** y **cero filas en
 * `platform_settings`**. No es que fallara a veces: esas rutas nunca funcionaron.
 *
 * ═══ POR QUÉ CONTRA POSTGRES DE VERDAD ═══
 *
 * Porque lo que estaba mal era el TIPO DE LA COLUMNA, y eso solo existe del lado de la base. Un
 * test con un doble del cliente habría pasado en verde con la columna en `uuid`: el error lo
 * produce Postgres al castear, no el código de la aplicación. Es la misma lección que el
 * favicon —comprobar que el código hace lo que hace no prueba que el sistema funcione— y la
 * misma que el timeout del pool, que también hubo que preguntárselo a Postgres.
 *
 * ═══ NO SE PRUEBA `plans` NI `platform_settings` POR SEPARADO ═══
 *
 * Lo que rompía no era ninguna de las dos tablas: era la columna que las audita. Se prueban las
 * DOS clases de clave que el producto tiene —texto y uuid— porque el arreglo tiene que servir a
 * las dos, y un test de una sola dejaría pasar un cambio que rompa la otra.
 */
describe('el registro de auditoría acepta la clave de la fila auditada', () => {
  let owner: ReturnType<typeof ownerConnection>;
  let staffId: string;
  let userId: string;

  beforeAll(async () => {
    await setupTestDatabase();
    owner = ownerConnection();
    const sufijo = randomUUID().slice(0, 8);
    // `staff` no tiene email: cuelga de `users` por `user_id` (esquema real, no el supuesto).
    const [u] = await owner`
      insert into users (workos_user_id, email)
      values (${`wos_audit_${sufijo}`}, ${`audit_${sufijo}@macha.test`})
      returning id`;
    userId = u!.id as string;
    const [s] = await owner`
      insert into staff (user_id, tier) values (${userId}, 'super_admin') returning id`;
    staffId = s!.id as string;
  });

  afterAll(async () => {
    await owner`delete from admin_audit_log where actor_staff_id = ${staffId}`;
    await owner`delete from staff where id = ${staffId}`;
    await owner`delete from users where id = ${userId}`;
    await owner.end({ timeout: 5 }).catch(() => {});
  });

  /*
   * EL CASO DEL BUG. `'starter'` es literalmente el valor que la ruta de planes pasaba y con el
   * que Postgres reventaba.
   */
  test('una clave de TEXTO se guarda (era el caso que reventaba)', async () => {
    const [fila] = await owner`
      insert into admin_audit_log (actor_staff_id, action, target_table, target_id, metadata)
      values (${staffId}, 'plan.update', 'plans', 'starter', ${'{}'}::jsonb)
      returning target_id`;
    expect(fila!.target_id).toBe('starter');
  });

  test('una clave de texto con guion bajo, como las de configuración', async () => {
    const [fila] = await owner`
      insert into admin_audit_log (actor_staff_id, action, target_table, target_id, metadata)
      values (${staffId}, 'platform_setting.update', 'platform_settings',
              'credit_to_tokens_ratio', ${'{}'}::jsonb)
      returning target_id`;
    expect(fila!.target_id).toBe('credit_to_tokens_ratio');
  });

  /*
   * La otra mitad del contrato: la mayoría de las tablas SÍ tienen clave uuid y esas se
   * siguen guardando igual. Cambiar la columna a texto no puede haberlas roto — un uuid es una
   * cadena válida y se conserva tal cual, sin normalizar.
   */
  test('una clave uuid sigue guardándose, y sin alterarse', async () => {
    const id = randomUUID();
    const [fila] = await owner`
      insert into admin_audit_log (actor_staff_id, action, target_table, target_id, metadata)
      values (${staffId}, 'company.suspend', 'companies', ${id}, ${'{}'}::jsonb)
      returning target_id`;
    expect(fila!.target_id).toBe(id);
  });

  /*
   * Y que el tipo sea el que creemos, preguntándoselo a Postgres. Sin esto, los tres tests de
   * arriba pasarían igual el día que alguien revierta la migración y la columna vuelva a
   * `uuid`… salvo los dos primeros, que fallarían con un mensaje sobre sintaxis de uuid en vez
   * de decir cuál es el problema. Esta aserción nombra la causa.
   */
  test('la columna es `text`, no `uuid`', async () => {
    const [col] = await owner`
      select data_type from information_schema.columns
       where table_schema = 'public' and table_name = 'admin_audit_log'
         and column_name = 'target_id'`;
    expect(col!.data_type).toBe('text');
  });
});
