import { describe, expect, test, beforeAll, afterAll } from 'bun:test';
import { setupTestDatabase, appConnection, rejectionCode, APPEND_ONLY_LEDGERS } from './setup';

/**
 * CU-868kh8zbj criterio 3: un UPDATE o DELETE sobre cada uno de los 6 ledgers
 * append-only debe fallar conectado como `macha_app`.
 *
 * Hasta ahora esto solo lo garantizaba que el rol de la app no fuera dueño de las
 * tablas — un hecho de configuración, no verificado por nada. Si alguien apunta
 * `APP_DATABASE_URL` al rol dueño (o la deja sin setear, y `env.ts` cae a
 * `DATABASE_URL`), la garantía desaparece en silencio y las correcciones dejan de ser
 * filas compensatorias para pasar a ser ediciones destructivas de un ledger contable.
 *
 * Las sentencias llevan `where false` a propósito: Postgres verifica los privilegios
 * ANTES de evaluar filas, así que el rechazo se produce igual con la tabla vacía. Eso
 * hace el test independiente de tener fixtures válidos para seis tablas distintas —
 * lo que se prueba es el privilegio, no los datos.
 */
describe('ledgers append-only (CU-868kh8zbj)', () => {
  let app: ReturnType<typeof appConnection>;

  beforeAll(async () => {
    await setupTestDatabase();
    app = appConnection();
  });

  afterAll(async () => {
    await app?.end();
  });

  test('la lista cubre los 7 ledgers que declara CLAUDE.md', () => {
    expect(APPEND_ONLY_LEDGERS.length).toBe(7);
  });

  for (const ledger of APPEND_ONLY_LEDGERS) {
    test(`UPDATE sobre ${ledger} es rechazado`, async () => {
      // 42501 = insufficient_privilege. Se comprueba el CÓDIGO y no solo que falle:
      // un error de sintaxis o de tabla inexistente también "fallaría" y daría un
      // verde falso.
      const code = await rejectionCode(app.unsafe(`update ${ledger} set id = id where false`));
      expect(code).toBe('42501');
    });

    test(`DELETE sobre ${ledger} es rechazado`, async () => {
      const code = await rejectionCode(app.unsafe(`delete from ${ledger} where false`));
      expect(code).toBe('42501');
    });
  }

  test('INSERT sí está permitido — append-only, no read-only', async () => {
    // El contraste importa: si el rol no pudiera insertar, los tests de arriba
    // pasarían por falta de permisos en general y no probarían nada específico.
    const [priv] = await app`
      select has_table_privilege(current_user, 'ai_usage_events', 'INSERT') as can_insert,
             has_table_privilege(current_user, 'ai_usage_events', 'UPDATE') as can_update,
             has_table_privilege(current_user, 'ai_usage_events', 'DELETE') as can_delete
    `;
    expect(priv).toMatchObject({ can_insert: true, can_update: false, can_delete: false });
  });

  test('una tabla mutable normal sigue aceptando UPDATE', async () => {
    // Control negativo: confirma que el REVOKE es específico de los ledgers y no un
    // efecto colateral de que macha_app tenga permisos capados en todo el esquema.
    const [priv] = await app`
      select has_table_privilege(current_user, 'documents', 'UPDATE') as can_update
    `;
    expect(priv!.can_update).toBe(true);
  });
});
