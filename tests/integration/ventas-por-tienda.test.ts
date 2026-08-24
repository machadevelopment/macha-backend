import { describe, expect, test, beforeAll, afterAll } from 'bun:test';
import { drizzle } from 'drizzle-orm/postgres-js';
import { ownerConnection, setupTestDatabase } from './setup';
import * as schema from '@/db/schema';
import { storeBreakdown } from '@/modules/metrics/stores';
import { StoreResolver } from '@/lib/store-dimension';
import type { DB } from '@/db/client';

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════
 * VENTAS POR TIENDA — CU-868kuw1e3
 * ═══════════════════════════════════════════════════════════════════════════════════════
 *
 * La tarjeta que pidió Jose para Ventas por producto, y la agregación que el asesor ya usaba
 * escrita a mano (CU-868kt8kk9). Ahora es una sola función; `dimension-tienda.test.ts` cubre
 * el camino del asesor y este cubre lo que la tarjeta agrega.
 *
 * Va contra Postgres real porque todo lo que puede fallar vive en la consulta: el `group by`
 * con `left join`, el reparto entre lo atribuido y lo que no lo está, el filtro por `type` y
 * el aislamiento entre empresas. Un mock devolvería lo que se le pida y no probaría ninguna
 * de las cuatro.
 *
 * Los montos son potencias de diez distintas para que cada total diga exactamente qué filas
 * lo componen: si una venta cae del lado equivocado, la suma no cuadra por un valor único en
 * vez de por una coincidencia.
 */
describe('ventas por tienda', () => {
  let owner: ReturnType<typeof ownerConnection>;
  let db: DB;
  let companyId: string;
  let vecina: string;
  let sinTiendas: string;

  beforeAll(async () => {
    await setupTestDatabase();
    owner = ownerConnection();
    db = drizzle(owner, { schema }) as unknown as DB;

    const crear = async (org: string, nombre: string): Promise<string> => {
      const [c] = await owner`
        insert into companies (workos_org_id, name, industry, base_currency)
        values (${org}, ${nombre}, 'retail', 'GTQ') returning id`;
      const id = c!.id as string;
      await owner.unsafe(
        `create table if not exists "transactions_${id.replace(/-/g, '_')}"
           partition of transactions for values in ('${id}')`,
      );
      return id;
    };

    companyId = await crear('org_vxt', 'Cadena VXT SA');
    vecina = await crear('org_vxt_b', 'Vecina VXT SA');
    sinTiendas = await crear('org_vxt_c', 'Sin Tiendas SA');

    const [u] = await owner`
      insert into users (workos_user_id, email)
      values ('wos_vxt', 'vxt@test.local') returning id`;

    const documentoDe = async (empresa: string): Promise<string> => {
      const [d] = await owner`
        insert into documents (company_id, uploaded_by, s3_key, original_filename,
                               file_size_bytes, mime_type)
        values (${empresa}, ${u!.id}, ${`${empresa}/a`}, 'a.xlsx', 100, 'text/csv')
        returning id`;
      return d!.id;
    };

    const doc = await documentoDe(companyId);
    const docVecina = await documentoDe(vecina);
    const docSinTiendas = await documentoDe(sinTiendas);

    const movimiento = async (
      empresa: string,
      documentId: string,
      tienda: string | null,
      monto: number,
      fecha: string,
      tipo: 'revenue' | 'cogs' | 'opex' = 'revenue',
      borrada = false,
    ) => {
      const storeId = tienda ? await new StoreResolver(db, empresa).resolve(tienda) : null;
      await owner`
        insert into transactions (company_id, document_id, type, category, date,
                                  original_amount, original_currency, amount_base,
                                  fx_rate, fx_rate_date, store_id, deleted_at)
        values (${empresa}, ${documentId}, ${tipo}, 'ventas', ${fecha},
                ${monto}, 'GTQ', ${monto}, 1, ${fecha}, ${storeId},
                ${borrada ? owner`now()` : null})`;
    };

    // Julio: NORTE 1000 (dos ventas) · SUR 500 · sin tienda 100  → atribuido 1500
    await movimiento(companyId, doc, 'NORTE', 600, '2026-07-05');
    await movimiento(companyId, doc, 'NORTE', 400, '2026-07-06');
    await movimiento(companyId, doc, 'SUR', 500, '2026-07-07');
    await movimiento(companyId, doc, null, 100, '2026-07-08');

    // Agosto: solo NORTE. Sirve para probar que el rango filtra de verdad.
    await movimiento(companyId, doc, 'NORTE', 70_000, '2026-08-03');

    // Ninguna de estas debe contar en julio, y van con montos a gritos por si el filtro falla:
    await movimiento(companyId, doc, 'NORTE', 900_000, '2026-07-09', 'cogs');
    await movimiento(companyId, doc, 'SUR', 800_000, '2026-07-09', 'opex');
    await movimiento(companyId, doc, 'SUR', 700_000, '2026-07-09', 'revenue', true);

    // Y esta es de OTRA empresa, con una tienda del mismo nombre y un monto que dominaría.
    await movimiento(vecina, docVecina, 'NORTE', 600_000, '2026-07-05');

    // Una empresa con ventas pero NINGUNA con tienda: el caso normal de una PYME.
    await movimiento(sinTiendas, docSinTiendas, null, 4_200, '2026-07-05');
  });

  afterAll(async () => {
    await owner?.end();
  });

  const julio = () => storeBreakdown(db, companyId, '2026-07-01', '2026-07-31');

  test('agrupa por tienda, suma en SQL y ordena de mayor a menor', async () => {
    const { rows } = await julio();

    expect(rows.map((r) => r.name)).toEqual(['NORTE', 'SUR']);
    // NORTE son DOS ventas: 600 + 400. Que sume 1000 es lo que demuestra el `group by`.
    expect(rows[0]).toMatchObject({ name: 'NORTE', total: 1000, transactionCount: 2 });
    expect(rows[1]).toMatchObject({ name: 'SUR', total: 500, transactionCount: 1 });
  });

  test('la venta SIN tienda va a su propio balde, ni al ranking ni a la basura', async () => {
    /*
     * Las dos salidas fáciles son las dos malas: agruparla bajo "Sin tienda" la pone a
     * competir por el primer puesto del ranking de sucursales, y tirarla hace que el total
     * de la tarjeta no cuadre con las ventas del período sin que nada lo explique.
     */
    const { rows, unattributedTotal } = await julio();

    expect(unattributedTotal).toBe(100);
    expect(rows.some((r) => r.total === 100)).toBe(false);
    for (const r of rows) expect(r.name.trim().length).toBeGreaterThan(0);
  });

  test('la participación es sobre lo ATRIBUIDO, no sobre las ventas del período', async () => {
    /*
     * Julio vendió 1600: 1500 con tienda y 100 sin ella. Si el denominador fuera 1600, las
     * rebanadas del donut sumarían 93,75 % y el hueco no lo explicaría nada. Con 1500 suman
     * 100 % y el frontend tiene `unattributedTotal` para decir de qué es ese 100 %.
     */
    const { rows } = await julio();

    expect(rows[0]!.sharePct).toBeCloseTo((1000 / 1500) * 100, 6);
    expect(rows[1]!.sharePct).toBeCloseTo((500 / 1500) * 100, 6);
    expect(rows.reduce((a, r) => a + r.sharePct, 0)).toBeCloseTo(100, 6);
  });

  test('solo cuenta `revenue`: costo, gasto y borradas quedan fuera', async () => {
    // Las tres van con montos de seis cifras: si alguna contara, NORTE no sumaría 1000.
    const { rows } = await julio();

    expect(rows.find((r) => r.name === 'NORTE')?.total).toBe(1000);
    expect(rows.find((r) => r.name === 'SUR')?.total).toBe(500);
  });

  test('respeta el rango de fechas', async () => {
    const agosto = await storeBreakdown(db, companyId, '2026-08-01', '2026-08-31');

    expect(agosto.rows).toEqual([
      expect.objectContaining({ name: 'NORTE', total: 70_000, sharePct: 100 }),
    ]);
    expect(agosto.unattributedTotal).toBe(0);
  });

  test('no se filtran las ventas de otra empresa', async () => {
    /*
     * La vecina tiene 600.000 en una tienda que se llama IGUAL. Si el filtro por `company_id`
     * fallara, dominaría el ranking — y sería una fuga entre inquilinos, no solo una cifra
     * mal puesta.
     */
    expect((await julio()).rows.find((r) => r.name === 'NORTE')?.total).toBe(1000);

    const suya = await storeBreakdown(db, vecina, '2026-07-01', '2026-07-31');
    expect(suya.rows).toEqual([expect.objectContaining({ name: 'NORTE', total: 600_000 })]);
  });

  test('"sin ninguna tienda" y "sin ninguna venta" son estados DISTINTOS', async () => {
    /*
     * Los dos devuelven `rows: []`, y la tarjeta tiene que decir cosas distintas: a una
     * empresa cuyo Excel no traía columna de tienda hay que explicarle que el dato no está en
     * su archivo; a una sin ventas en el período, que no hay ventas. `unattributedTotal` es lo
     * único que las separa, y por eso viaja siempre, también en cero.
     */
    const conVentas = await storeBreakdown(db, sinTiendas, '2026-07-01', '2026-07-31');
    expect(conVentas.rows).toEqual([]);
    expect(conVentas.unattributedTotal).toBe(4_200);

    const sinVentas = await storeBreakdown(db, sinTiendas, '2020-01-01', '2020-01-31');
    expect(sinVentas.rows).toEqual([]);
    expect(sinVentas.unattributedTotal).toBe(0);
  });

  test('sin rango, agrega TODO el histórico — es lo que usa el asesor', async () => {
    // El asesor llama sin fechas cuando el usuario no las da. Julio + agosto de NORTE.
    const todo = await storeBreakdown(db, companyId);

    expect(todo.rows.find((r) => r.name === 'NORTE')?.total).toBe(71_000);
  });
});
