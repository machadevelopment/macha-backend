import { describe, expect, test, beforeAll, afterAll } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { setupTestDatabase, appConnection, ownerConnection, rejectionCode } from './setup';

/**
 * CU-868kjc5pj: una versión de reporte se inserta COMPLETA, de una sola escritura.
 *
 * `tests/integration/append-only.test.ts` ya probaba que la base rechaza un UPDATE
 * sobre `report_versions`… y estaba en verde mientras el código de producción hacía
 * justo ese UPDATE para poner `s3_render_key` después del INSERT. Aquel test prueba el
 * privilegio con la tabla vacía; este prueba la FORMA de escritura que usa el código
 * real, con el rol `macha_app` y con datos.
 */
describe('report_versions se escribe de una sola vez (CU-868kjc5pj)', () => {
  let app: ReturnType<typeof appConnection>;
  let owner: ReturnType<typeof ownerConnection>;
  let companyId: string;
  let reportId: string;

  beforeAll(async () => {
    await setupTestDatabase();
    app = appConnection();
    owner = ownerConnection();

    const [c] = await owner`
      insert into companies (workos_org_id, name, industry)
      values ('org_rv', 'Reportes SA', 'retail') returning id
    `;
    companyId = c!.id;

    const [r] = await owner`
      insert into reports (company_id, period_start, period_end, frequency)
      values (${companyId}, '2026-07-01', '2026-07-31', 'daily') returning id
    `;
    reportId = r!.id;
  });

  afterAll(async () => {
    await app?.end();
    await owner?.end();
  });

  /** Reproduce el flujo del guard: transacción + SET LOCAL app.company_id. */
  function asCompany<T>(fn: (tx: TxSql) => Promise<T>): Promise<T> {
    return app.begin(async (tx) => {
      await tx`select set_config('app.company_id', ${companyId}, true)`;
      return fn(tx as unknown as TxSql);
    }) as Promise<T>;
  }

  test('el rol de la app puede insertar una versión con s3_render_key ya puesto', async () => {
    // Exactamente lo que hace ahora lib/reports.ts: id generado en la app, clave de S3
    // derivada de ese id, y una única escritura con todo dentro.
    const versionId = randomUUID();
    const renderKey = `${companyId}/reports/${versionId}.html`;

    const rows = await asCompany(
      (tx) => tx`
        insert into report_versions (id, company_id, report_id, version, metrics,
                                     narrative, s3_render_key)
        values (${versionId}, ${companyId}, ${reportId}, 1, '{"revenue":100}'::jsonb,
                'narrativa', ${renderKey})
        returning id, s3_render_key
      `,
    );

    expect(rows[0]!.id).toBe(versionId);
    expect(rows[0]!.s3_render_key).toBe(renderKey);
  });

  test('y NO puede completarla después: el UPDATE que había en el código es rechazado', async () => {
    // El fallo exacto que rompía la generación de reportes con macha_app.
    // 42501 = insufficient_privilege.
    const code = await rejectionCode(
      app.unsafe(`update report_versions set s3_render_key = 'otro' where false`),
    );
    expect(code).toBe('42501');
  });

  test('la versión insertada es visible para su empresa y para nadie más', async () => {
    const propias = await asCompany((tx) => tx`select id from report_versions`);
    expect(propias.length).toBe(1);

    const ajenas = await app.begin(async (tx) => {
      await tx`select set_config('app.company_id', ${randomUUID()}, true)`;
      return tx`select id from report_versions`;
    });
    expect(ajenas).toEqual([]);
  });
});

// Tipo mínimo del tagged-template de una transacción de `postgres` — la librería no
// exporta uno usable aquí y no vale la pena arrastrar sus genéricos completos.
type TxSql = <T = Record<string, unknown>>(
  strings: TemplateStringsArray,
  ...values: unknown[]
) => Promise<T[]>;
