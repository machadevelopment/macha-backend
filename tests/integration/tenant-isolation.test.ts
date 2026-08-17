import { describe, expect, test, beforeAll, afterAll } from 'bun:test';
import { setupTestDatabase, appConnection, ownerConnection, rejectionCode } from './setup';

/**
 * CU-868kh8zbj criterio 2: tests de aislamiento que FALLEN si RLS se desactiva.
 *
 * La regla no negociable más citada del proyecto (`company_id` en toda query,
 * CLAUDE.md) era la menos verificada: los 123 tests unitarios no abren una sola
 * conexión a Postgres, así que una regresión en RLS pasaba el CI sin despeinarse.
 *
 * El mecanismo real: `guards/tenant.derive.ts` abre una transacción por request y
 * hace `SET LOCAL app.company_id`; las políticas de RLS (migraciones 0002/0009) leen
 * ese GUC. Aquí se reproduce ese flujo tal cual, sin pasar por Elysia, para probar el
 * backstop de base de datos por separado del guard que lo alimenta.
 */
describe('aislamiento por RLS entre empresas (CU-868kh8zbj)', () => {
  let app: ReturnType<typeof appConnection>;
  let owner: ReturnType<typeof ownerConnection>;
  let companyA: string;
  let companyB: string;
  let userId: string;

  beforeAll(async () => {
    await setupTestDatabase();
    app = appConnection();
    owner = ownerConnection();

    // Los datos se montan con el rol DUEÑO a propósito: sembrar con el rol
    // restringido obligaría a setear el GUC y enturbiaría qué se está probando.
    const [a] = await owner`
      insert into companies (workos_org_id, name, industry)
      values ('org_rls_a', 'Empresa A', 'retail') returning id
    `;
    const [b] = await owner`
      insert into companies (workos_org_id, name, industry)
      values ('org_rls_b', 'Empresa B', 'retail') returning id
    `;
    companyA = a!.id;
    companyB = b!.id;

    const [u] = await owner`
      insert into users (workos_user_id, email) values ('wos_rls_1', 'rls@test.local')
      returning id
    `;
    userId = u!.id;

    for (const [companyId, filename] of [
      [companyA, 'a.xlsx'],
      [companyB, 'b.xlsx'],
    ] as const) {
      await owner`
        insert into documents (company_id, uploaded_by, s3_key, original_filename,
                               file_size_bytes, mime_type)
        values (${companyId}, ${userId}, ${`${companyId}/x`}, ${filename}, 100,
                'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      `;
    }
  });

  afterAll(async () => {
    await app?.end();
    await owner?.end();
  });

  /** Reproduce el flujo de tenant.derive: transacción + SET LOCAL app.company_id. */
  async function asCompany<T>(
    companyId: string,
    fn: (tx: postgresTransaction) => Promise<T>,
  ): Promise<T> {
    return app.begin(async (tx) => {
      await tx`select set_config('app.company_id', ${companyId}, true)`;
      return fn(tx as unknown as postgresTransaction);
    }) as Promise<T>;
  }

  test('una empresa solo ve sus propios documentos', async () => {
    const rows = await asCompany(companyA, (tx) => tx`select original_filename from documents`);
    expect(rows.map((r: { original_filename: string }) => r.original_filename)).toEqual(['a.xlsx']);
  });

  test('la otra empresa ve los suyos y solo los suyos', async () => {
    const rows = await asCompany(companyB, (tx) => tx`select original_filename from documents`);
    expect(rows.map((r: { original_filename: string }) => r.original_filename)).toEqual(['b.xlsx']);
  });

  test('pedir explícitamente las filas de OTRA empresa no devuelve nada', async () => {
    // El caso que de verdad importa: no es que la query olvide filtrar, es que la
    // query filtra a propósito por la empresa ajena. RLS debe vaciar el resultado
    // aunque el WHERE pida justamente esas filas.
    const rows = await asCompany(
      companyA,
      (tx) => tx`select id from documents where company_id = ${companyB}`,
    );
    expect(rows).toEqual([]);
  });

  test('sin app.company_id seteado no se filtra ninguna fila', async () => {
    // Si un endpoint nuevo se saltara tenant.derive, el fallo debe ser "no ve nada",
    // nunca "las ve todas".
    //
    // Hay DOS formas de fallar cerrado y ambas son aceptables, según si el GUC nunca
    // se tocó en la sesión o se tocó y volvió a '' al cerrar la transacción:
    //  - nunca tocado: current_setting(..., true) da NULL → `= NULL` filtra todo → [].
    //  - tocado y revertido: da '' → el cast a uuid revienta con 22P02.
    // Lo que este test prohíbe es la tercera: devolver filas.
    let rows: unknown[] | undefined;
    try {
      rows = await app`select id from documents`;
    } catch (err) {
      expect((err as { code?: string }).code).toBe('22P02');
      return;
    }
    expect(rows).toEqual([]);
  });

  test('no se puede insertar una fila a nombre de otra empresa', async () => {
    // WITH CHECK de la política: el aislamiento de escritura importa tanto como el
    // de lectura — sin esto, un tenant podría plantar datos en otro.
    // try/catch vía rejectionCode, no `.rejects`: ver la nota en setup.ts — esa
    // combinación cuelga con los errores de la librería `postgres` en Bun 1.3.14.
    const code = await rejectionCode(
      asCompany(
        companyA,
        (tx) => tx`
          insert into documents (company_id, uploaded_by, s3_key, original_filename,
                                 file_size_bytes, mime_type)
          values (${companyB}, ${userId}, 'x/y', 'intruso.xlsx', 1, 'text/csv')
        `,
      ),
    );
    // 42501: la política WITH CHECK rechaza la fila.
    expect(code).toBe('42501');
  });

  test('tras cerrar la transacción, la MISMA conexión vuelve a no ver nada (CU-868kj3utc)', async () => {
    // El bug más sutil del ticket, y el que rompía la segunda request de cada conexión
    // del pool: `current_setting(x, true)` devuelve NULL solo mientras el GUC nunca se
    // ha seteado. En cuanto una transacción hace SET LOCAL y termina, el parámetro
    // vuelve a su valor de sesión, que para un GUC personalizado es la CADENA VACÍA —
    // y `''::uuid` no da NULL, lanza `invalid input syntax for type uuid: ""`.
    //
    // Este test corre sobre `app`, la misma conexión (max: 1) que los tests de arriba
    // ya usaron con SET LOCAL, así que el GUC YA está revertido a ''. Con la política
    // vieja esto no devolvía [], reventaba.
    await asCompany(companyA, (tx) => tx`select id from documents`);

    const rows = await app`select id from documents`;
    expect(rows).toEqual([]);
  });

  test('el conteo con el rol dueño confirma que las dos filas existen', async () => {
    // Cierra el círculo: los tests de arriba podrían pasar simplemente porque la
    // tabla está vacía. Esto prueba que los datos SÍ están y que lo que los oculta
    // es RLS, no la ausencia de filas.
    //
    // Se cuenta SOLO sobre las dos empresas de este test, no la tabla entera. Un conteo
    // global afirma algo sobre el resto de la suite —que ningún otro archivo cree
    // documentos— que no es asunto de este test y que se rompe cada vez que alguien agrega
    // un fixture en otro lado. Pasó: los tests de importación de inventario empezaron a
    // crear los suyos y este falló sin que el aislamiento tuviera nada malo.
    const [row] = await owner`
      select count(*)::int as count from documents
      where company_id in (${companyA}, ${companyB})
    `;
    expect(row!.count).toBe(2);
  });
});

// Tipo mínimo del tagged-template de una transacción de `postgres` — la librería no
// exporta uno usable aquí y no vale la pena arrastrar sus genéricos completos.
type postgresTransaction = <T = Record<string, unknown>>(
  strings: TemplateStringsArray,
  ...values: unknown[]
) => Promise<T[]>;
