import { describe, expect, test, beforeAll, afterAll } from 'bun:test';
import { drizzle } from 'drizzle-orm/postgres-js';
import { ownerConnection, setupTestDatabase } from './setup';
import * as schema from '@/db/schema';
import { counterpartyConcentration } from '@/modules/metrics/counterparties';
import type { DB } from '@/db/client';

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════
 * CONCENTRACIÓN DE LA CARTERA POR CONTRAPARTE — CU-868kt29t0
 * ═══════════════════════════════════════════════════════════════════════════════════════
 *
 * Los tabs de Cuentas por cobrar y por pagar necesitan saber **a quién cobrarle primero**,
 * que es lo accionable; el total ya lo daba `/ar-ap`.
 *
 * Va contra Postgres real y no en unitarios porque todo lo que puede fallar acá vive en la
 * consulta: el `group by`, la suma condicional del vencido, el `limit + 1` que decide si hay
 * resto, y el `<> all(...)` que lo separa. Un mock haría exactamente lo que el código le
 * pida y no probaría ninguna de esas cuatro cosas.
 *
 * Los montos son potencias de dos para que cada total diga exactamente qué filas lo
 * componen: si una factura cae del lado equivocado, la suma no cuadra por un valor único en
 * vez de por una coincidencia.
 */
describe('concentración por contraparte', () => {
  let owner: ReturnType<typeof ownerConnection>;
  let db: DB;
  let companyId: string;
  let otraEmpresa: string;

  beforeAll(async () => {
    await setupTestDatabase();
    owner = ownerConnection();
    db = drizzle(owner, { schema }) as unknown as DB;

    const crearEmpresa = async (org: string, nombre: string): Promise<string> => {
      const [c] = await owner`
        insert into companies (workos_org_id, name, industry)
        values (${org}, ${nombre}, 'retail') returning id
      `;
      const id = c!.id as string;
      const suffix = id.replace(/-/g, '_');
      for (const tabla of ['invoices', 'bills']) {
        await owner.unsafe(
          `create table if not exists "${tabla}_${suffix}" partition of ${tabla}
             for values in ('${id}')`,
        );
      }
      return id;
    };

    companyId = await crearEmpresa('org_contrapartes', 'Contrapartes SA');
    otraEmpresa = await crearEmpresa('org_contrapartes_b', 'Vecina SA');

    const [u] = await owner`
      insert into users (workos_user_id, email)
      values ('wos_contrapartes', 'contrapartes@test.local') returning id
    `;

    const documentoDe = async (empresa: string): Promise<string> => {
      const [d] = await owner`
        insert into documents (company_id, uploaded_by, s3_key, original_filename,
                               file_size_bytes, mime_type)
        values (${empresa}, ${u!.id}, ${`${empresa}/a`}, 'a.xlsx', 100, 'text/csv')
        returning id
      `;
      return d!.id;
    };

    const doc = await documentoDe(companyId);
    const docVecina = await documentoDe(otraEmpresa);

    /**
     * `diasDeAtraso` null = sin fecha de vencimiento, que cuenta como AL DÍA — igual que en
     * el aging. Una factura sin fecha no está vencida: no se sabe cuándo vence.
     */
    const factura = async (
      empresa: string,
      documentId: string,
      contraparte: string,
      monto: number,
      diasDeAtraso: number | null,
      estado: 'open' | 'paid' = 'open',
      borrada = false,
    ) => {
      await owner`
        insert into invoices (company_id, document_id, counterparty, issue_date, due_date,
                              original_amount, original_currency, amount_base,
                              fx_rate, fx_rate_date, status, deleted_at)
        values (${empresa}, ${documentId}, ${contraparte}, current_date - 200,
                ${diasDeAtraso === null ? null : owner`current_date - ${diasDeAtraso}::int`},
                ${monto}, 'GTQ', ${monto}, 1, current_date - 200, ${estado},
                ${borrada ? owner`now()` : null})
      `;
    };

    // ACME: 1000 al día + 500 con 45 días de atraso  → total 1500, vencido 500, peor 31_60
    await factura(companyId, doc, 'ACME', 1000, null);
    await factura(companyId, doc, 'ACME', 500, 45);
    // BETA: 800 con 100 días de atraso                → total 800, vencido 800, peor 90_plus
    await factura(companyId, doc, 'BETA', 800, 100);
    // GAMMA: 200 al día                               → total 200, vencido 0, peor current
    await factura(companyId, doc, 'GAMMA', 200, -5);
    // DELTA: 100 al día                               → el más chico, es lo que cae al resto
    await factura(companyId, doc, 'DELTA', 100, null);

    // Ninguna de estas dos debe contar: una está pagada, la otra borrada. Van con montos
    // enormes para que aparezcan a gritos si el filtro se rompe.
    await factura(companyId, doc, 'ACME', 999_000, 10, 'paid');
    await factura(companyId, doc, 'OMEGA', 888_000, 10, 'open', true);

    // Y esta es de OTRA empresa, con la misma contraparte y un monto que dominaría el
    // ranking si el filtro por `company_id` fallara.
    await factura(otraEmpresa, docVecina, 'ACME', 777_000, 10);
  });

  afterAll(async () => {
    await owner?.end();
  });

  test('ordena por monto y agrega las facturas de la misma contraparte', async () => {
    const { ar } = await counterpartyConcentration(db, companyId, 10);

    expect(ar.top.map((f) => f.counterparty)).toEqual(['ACME', 'BETA', 'GAMMA', 'DELTA']);
    // ACME son DOS facturas: 1000 + 500. Que sume 1500 es lo que demuestra el `group by`.
    expect(ar.top[0]).toMatchObject({ counterparty: 'ACME', total: 1500, invoiceCount: 2 });
  });

  test('el vencido es la parte con fecha pasada, no el total', async () => {
    const { ar } = await counterpartyConcentration(db, companyId, 10);
    const porNombre = new Map(ar.top.map((f) => [f.counterparty, f]));

    // De los 1500 de ACME, solo 500 están vencidos. Confundir esto con el total es
    // exactamente el error que haría que el tab reporte mora donde no hay.
    expect(porNombre.get('ACME')).toMatchObject({ total: 1500, overdue: 500 });
    expect(porNombre.get('BETA')).toMatchObject({ total: 800, overdue: 800 });
    expect(porNombre.get('GAMMA')).toMatchObject({ total: 200, overdue: 0 });
  });

  test('una factura SIN fecha de vencimiento no cuenta como vencida', async () => {
    // DELTA solo tiene la factura sin `due_date`. Tratarla como vencida inflaría la mora
    // con documentos que el Excel del cliente trajo sin fecha, que son muchos.
    const { ar } = await counterpartyConcentration(db, companyId, 10);
    const delta = ar.top.find((f) => f.counterparty === 'DELTA');

    expect(delta).toMatchObject({ total: 100, overdue: 0, worstBucket: 'current' });
  });

  test('worstBucket es el balde MÁS grave, no el último ni el alfabético', async () => {
    /*
     * ACME tiene una factura al día y una de 45 días. El peor es `31_60`, y esto no sale de
     * un `max()` sobre el texto: alfabéticamente '90_plus' va después de '1_30' pero ANTES
     * de 'current', así que ordenar por texto daría 'current' para una contraparte con mora
     * de tres meses — el renglón se pintaría verde justo en el caso que hay que cobrar.
     */
    const { ar } = await counterpartyConcentration(db, companyId, 10);
    const porNombre = new Map(ar.top.map((f) => [f.counterparty, f]));

    expect(porNombre.get('ACME')?.worstBucket).toBe('31_60');
    expect(porNombre.get('BETA')?.worstBucket).toBe('90_plus');
    expect(porNombre.get('GAMMA')?.worstBucket).toBe('current');
  });

  test('pagadas y borradas NO cuentan', async () => {
    const { ar } = await counterpartyConcentration(db, companyId, 10);

    // La pagada de ACME es de 999.000: si contara, su total no sería 1500.
    expect(ar.top.find((f) => f.counterparty === 'ACME')?.total).toBe(1500);
    // Y OMEGA no debería existir en el ranking: su única factura está borrada.
    expect(ar.top.map((f) => f.counterparty)).not.toContain('OMEGA');
  });

  test('no se filtra la cartera de otra empresa', async () => {
    // La vecina tiene 777.000 a nombre de ACME. Si el `company_id` fallara, dominaría el
    // ranking — y sería una fuga de datos entre inquilinos, no solo una cifra mal.
    const { ar } = await counterpartyConcentration(db, companyId, 10);
    expect(ar.top.find((f) => f.counterparty === 'ACME')?.total).toBe(1500);

    const vecina = await counterpartyConcentration(db, otraEmpresa, 10);
    expect(vecina.ar.top).toEqual([
      expect.objectContaining({ counterparty: 'ACME', total: 777_000 }),
    ]);
  });

  test('con tope, el resto agrega lo que quedó fuera y la suma CIERRA', async () => {
    /*
     * El punto del `resto`. Sin él la interfaz muestra un top que no suma al total de
     * `/ar-ap`, y dos cifras que no cuadran en la misma pantalla se leen como un error de
     * cálculo aunque las dos estén bien.
     */
    const { ar } = await counterpartyConcentration(db, companyId, 2);

    expect(ar.top.map((f) => f.counterparty)).toEqual(['ACME', 'BETA']);
    // GAMMA (200) + DELTA (100), dos contrapartes.
    expect(ar.resto).toEqual({ total: 300, counterpartyCount: 2 });

    const total = ar.top.reduce((s, f) => s + f.total, 0) + ar.resto.total;
    expect(total).toBe(1500 + 800 + 200 + 100);
  });

  test('si la cartera cabe entera, el resto viene en cero (no ausente)', async () => {
    // Cero y no `undefined`: obligar a la UI a distinguir "no hay resto" de "no me lo
    // mandaron" cuando la respuesta correcta a las dos es la misma solo invita a un bug.
    const { ar } = await counterpartyConcentration(db, companyId, 10);
    expect(ar.resto).toEqual({ total: 0, counterpartyCount: 0 });
  });

  test('una empresa sin cartera devuelve listas vacías, no revienta', async () => {
    // Es el estado de toda empresa antes de su primera carga con facturas.
    const vacia = await counterpartyConcentration(db, otraEmpresa, 10);
    expect(vacia.ap).toEqual({ top: [], resto: { total: 0, counterpartyCount: 0 } });
  });

  test('el tope se acota: un limit disparatado no trae la cartera entera', async () => {
    // `limit` viene de un query param, o sea de texto que escribe el cliente.
    const { ar } = await counterpartyConcentration(db, companyId, 10_000);
    expect(ar.top.length).toBeLessThanOrEqual(50);
  });
});
