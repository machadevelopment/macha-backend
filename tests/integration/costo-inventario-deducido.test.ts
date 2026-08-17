import { describe, expect, test, beforeAll, afterAll } from 'bun:test';
import { drizzle } from 'drizzle-orm/postgres-js';
import { ownerConnection, setupTestDatabase } from './setup';
import * as schema from '@/db/schema';
import { costosUnitariosDeducidos } from '@/modules/inventory/derived-cost';
import type { DB } from '@/db/client';

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════
 * CU-868kt25ev — EL COSTO UNITARIO Y EL VALOR DE INVENTARIO EN CERO
 * ═══════════════════════════════════════════════════════════════════════════════════════
 *
 * Verificado contra producción antes de escribir una línea, y el patrón dice dónde está:
 *
 * ```
 * Techstore       54 items · 0 en cero  ✓        Candelas      42 items · 42 en cero  ✗
 * Electro Hogar   36 items · 0 en cero  ✓        DanielPrueba  42 items · 42 en cero  ✗
 * ```
 *
 * No es que la ingesta lea mal el costo: **la hoja `Inventario` de esa plantilla no tiene
 * columna de costo**. Pero el costo SÍ está en el archivo, en `Ventas` (`CostoUnitario`),
 * y ya entra al sistema como movimientos `cogs` ligados al producto.
 *
 * El fixture reproduce la forma EXACTA de esos datos de producción, incluido el detalle que
 * obliga al rodeo: las filas `cogs` que deriva la ingesta **no llevan `quantity`** (medido:
 * 551 filas de costo, 551 con producto, 0 con cantidad). Las unidades salen de las filas de
 * INGRESO de la misma venta.
 *
 * Los números son los del cliente real: `LDC-ACC-0024` cuesta 12,56 en su Excel.
 */
describe('costo unitario deducido de las ventas', () => {
  let owner: ReturnType<typeof ownerConnection>;
  let db: DB;
  let companyId: string;
  const productos = new Map<string, string>();

  beforeAll(async () => {
    await setupTestDatabase();
    owner = ownerConnection();
    db = drizzle(owner, { schema }) as unknown as DB;

    const [c] = await owner`
      insert into companies (workos_org_id, name, industry, base_currency)
      values ('org_costo_inv', 'Velas SA', 'retail', 'GTQ') returning id`;
    companyId = c!.id;
    await owner.unsafe(
      `create table if not exists "transactions_${companyId.replace(/-/g, '_')}"
         partition of transactions for values in ('${companyId}')`,
    );

    const [u] = await owner`
      insert into users (workos_user_id, email)
      values ('wos_costo_inv', 'costo_inv@test.local') returning id`;
    const [d] = await owner`
      insert into documents (company_id, uploaded_by, s3_key, original_filename,
                             file_size_bytes, mime_type)
      values (${companyId}, ${u!.id}, ${`${companyId}/a`}, 'a.xlsx', 100, 'text/csv')
      returning id`;
    const documentId = d!.id;

    for (const sku of ['LDC-ACC-0024', 'LDC-VEL-0041', 'LDC-SIN-VENTA']) {
      const [p] = await owner`
        insert into products (company_id, name) values (${companyId}, ${sku}) returning id`;
      productos.set(sku, p!.id);
    }

    /**
     * `cogs` SIN cantidad e `revenue` CON cantidad — la asimetría real de producción.
     * Si el código dedujera dividiendo por la cantidad de la fila de costo, acá daría
     * `null` y el test fallaría, que es exactamente lo que tiene que pasar.
     */
    const movimiento = async (
      sku: string,
      tipo: 'revenue' | 'cogs',
      monto: number,
      unidades: number | null,
    ) => {
      await owner`
        insert into transactions (company_id, document_id, type, category, date, description,
                                  original_amount, original_currency, amount_base,
                                  fx_rate, fx_rate_date, product_id, quantity)
        values (${companyId}, ${documentId}, ${tipo}, 'ventas', '2026-07-15', ${sku},
                ${monto}, 'GTQ', ${monto}, 1, '2026-07-15',
                ${productos.get(sku)!}, ${unidades})`;
    };

    // LDC-ACC-0024: 26 unidades vendidas, 326.56 de costo → 12.56 exactos, como el Excel.
    await movimiento('LDC-ACC-0024', 'revenue', 1091.74, 26);
    await movimiento('LDC-ACC-0024', 'cogs', 326.56, null);
    // LDC-VEL-0041: 10 unidades, 66.20 → 6.62.
    await movimiento('LDC-VEL-0041', 'revenue', 229.9, 10);
    await movimiento('LDC-VEL-0041', 'cogs', 66.2, null);
    // LDC-SIN-VENTA: existe como producto pero nunca se vendió. No debe deducir nada.
  });

  afterAll(async () => {
    await owner?.end();
  });

  test('deduce el costo unitario que trae el Excel del cliente, al centavo', async () => {
    const costos = await costosUnitariosDeducidos(db, companyId);
    expect(costos.get(productos.get('LDC-ACC-0024')!)).toBeCloseTo(12.56, 2);
    expect(costos.get(productos.get('LDC-VEL-0041')!)).toBeCloseTo(6.62, 2);
  });

  test('las unidades salen de la venta, no de la fila de costo', async () => {
    /*
     * El detalle que obliga al rodeo. Las filas `cogs` que la ingesta deriva de una venta
     * NO llevan `quantity` — medido en producción: 551 de costo, 0 con cantidad. Dividir
     * por la cantidad de la propia fila de costo daría división por nada.
     */
    const [sinCantidad] = await owner`
      select count(*)::int as n from transactions
      where company_id = ${companyId} and type = 'cogs' and quantity is not null`;
    expect(sinCantidad!.n).toBe(0);

    // Y aun así el costo se deduce, porque las unidades vienen del ingreso.
    const costos = await costosUnitariosDeducidos(db, companyId);
    expect(costos.size).toBeGreaterThan(0);
  });

  test('un producto sin ventas NO deduce nada, en vez de deducir cero', async () => {
    // Devolver 0 sería indistinguible del cero que este arreglo vino a resolver: la
    // pantalla volvería a mostrar un valor de inventario falso, solo que por otra vía.
    const costos = await costosUnitariosDeducidos(db, companyId);
    expect(costos.has(productos.get('LDC-SIN-VENTA')!)).toBe(false);
  });

  test('un movimiento revertido deja de contar', async () => {
    // Si un `soft delete` no se respetara, el costo promedio se calcularía con ventas que
    // el cliente ya deshizo — y encima no habría forma de notarlo mirando la pantalla.
    await owner`
      update transactions set deleted_at = now()
      where company_id = ${companyId} and description = 'LDC-VEL-0041'`;

    const costos = await costosUnitariosDeducidos(db, companyId);
    expect(costos.has(productos.get('LDC-VEL-0041')!)).toBe(false);
    // El otro producto no se ve afectado.
    expect(costos.get(productos.get('LDC-ACC-0024')!)).toBeCloseTo(12.56, 2);

    await owner`
      update transactions set deleted_at = null
      where company_id = ${companyId} and description = 'LDC-VEL-0041'`;
  });

  test('no se filtra el costo de otra empresa', async () => {
    // El costo de un producto es dato de negocio de su dueño. Un fallo de scoping acá sería
    // una fuga entre inquilinos, no solo una cifra mal.
    // Nombre único a propósito: `companies` tiene UNIQUE sobre `lower(name)` para TODA la
    // instalación, así que un nombre genérico choca con el fixture de otro archivo de test
    // y el fallo aparece como un error de constraint sin relación con lo que se prueba.
    const [otra] = await owner`
      insert into companies (workos_org_id, name, industry, base_currency)
      values ('org_costo_inv_b', 'Vecina Costo Inventario SA', 'retail', 'GTQ') returning id`;

    const costos = await costosUnitariosDeducidos(db, otra!.id);
    expect(costos.size).toBe(0);
  });
});
