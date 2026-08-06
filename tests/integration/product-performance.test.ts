import { describe, expect, test, beforeAll, afterAll } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/postgres-js';
import { setupTestDatabase, ownerConnection } from './setup';
import * as schema from '@/db/schema';
import { provisionTenantPartitions } from '@/lib/tenant-provisioning';
import { productPerformance } from '@/modules/metrics/products';

/**
 * Lo que alimenta la pantalla de Ventas por producto, contra datos reales.
 *
 * Las tres cosas que se prueban aquí no son aritmética trivial: son las decisiones que
 * hacen que la pantalla diga la verdad cuando el Excel del cliente viene incompleto, que es
 * el caso normal y no la excepción.
 */
describe('desempeño por producto', () => {
  let owner: ReturnType<typeof ownerConnection>;
  let db: ReturnType<typeof drizzle<typeof schema>>;
  const empresa = randomUUID();
  const documento = randomUUID();
  const RANGO = { from: '2026-03-01', to: '2026-03-31' };

  const producto = async (nombre: string, categoria: string | null): Promise<string> => {
    const [fila] = await owner`
      insert into products (company_id, name, category)
      values (${empresa}, ${nombre}, ${categoria})
      returning id
    `;
    return fila!.id as string;
  };

  const movimiento = async (
    productId: string,
    tipo: 'revenue' | 'cogs',
    monto: number,
    cantidad: number | null,
    fecha = '2026-03-10',
  ) => {
    await owner`
      insert into transactions (
        company_id, document_id, product_id, date, type, category,
        original_amount, original_currency, amount_base, fx_rate, fx_rate_date, quantity
      ) values (
        ${empresa}, ${documento}, ${productId}, ${fecha}, ${tipo}, 'ventas',
        ${monto}, 'GTQ', ${monto}, 1, ${fecha}, ${cantidad}
      )
    `;
  };

  beforeAll(async () => {
    await setupTestDatabase();
    owner = ownerConnection();
    db = drizzle(owner, { schema });
    await owner`
      insert into companies (id, workos_org_id, name, industry, base_currency, locale)
      values (${empresa}, ${'org_' + empresa}, ${'Ventas ' + empresa}, 'retail', 'GTQ', 'es')
    `;
    // transactions está particionada por company_id: sin su partición, los INSERT de este
    // test fallarían con "no partition of relation found for row".
    await provisionTenantPartitions(empresa);
    await owner`
      insert into documents (
        id, company_id, uploaded_by, s3_key, original_filename,
        file_size_bytes, mime_type, status
      ) values (
        ${documento}, ${empresa}, ${randomUUID()}, ${empresa + '/ventas.xlsx'}, 'ventas.xlsx',
        1024, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'promoted'
      )
    `;
  });

  afterAll(async () => {
    await owner?.end();
  });

  test('las unidades son null cuando ninguna fila del producto las trae — y null no es cero', async () => {
    // El caso normal: el libro tiene montos pero no una columna de cantidad. Devolver 0
    // diría "se vendieron cero unidades" de un producto que facturó miles, y el ticket
    // promedio de la pantalla se calcularía sobre esa mentira.
    const id = await producto('Servicio de asesoría', 'servicios');
    await movimiento(id, 'revenue', 5000, null);

    const [fila] = await productPerformance(db, empresa, RANGO.from, RANGO.to);
    expect(fila!.revenue).toBe(5000);
    expect(fila!.units).toBeNull();
    expect(fila!.revenueWithUnits).toBe(0);
  });

  test('el ingreso del ticket promedio solo cuenta las filas que sí traen unidades', async () => {
    // Mezclar: 2 ventas de 100 con 10 unidades cada una, y una de 800 sin unidades. El
    // ticket honesto es 200/20 = 10, no 1000/20 = 50. Dividir el ingreso TOTAL entre las
    // unidades de un subconjunto infla el ticket mientras más incompleto venga el archivo.
    const id = await producto('Café Antigua 500g', 'bebidas');
    await movimiento(id, 'revenue', 100, 10);
    await movimiento(id, 'revenue', 100, 10);
    await movimiento(id, 'revenue', 800, null);

    const filas = await productPerformance(db, empresa, RANGO.from, RANGO.to);
    const cafe = filas.find((f) => f.name === 'Café Antigua 500g')!;
    expect(cafe.revenue).toBe(1000);
    expect(cafe.units).toBe(20);
    expect(cafe.revenueWithUnits).toBe(200);
    expect(cafe.revenueWithUnits / cafe.units!).toBe(10);
  });

  test('el margen sale de la definición compartida: ingreso menos costo directo', async () => {
    const id = await producto('Azúcar 1lb', 'abarrotes');
    await movimiento(id, 'revenue', 1000, 100);
    await movimiento(id, 'cogs', 600, null);

    const filas = await productPerformance(db, empresa, RANGO.from, RANGO.to);
    const azucar = filas.find((f) => f.name === 'Azúcar 1lb')!;
    expect(azucar.revenue).toBe(1000);
    expect(azucar.cogs).toBe(600);
    expect(azucar.grossProfit).toBe(400);
    expect(azucar.grossMarginPct).toBe(40);
  });

  test('la participación se calcula sobre TODOS los productos, no sobre los que sobreviven al limit', async () => {
    // Si se calculara sobre la lista recortada, los porcentajes de un top 1 sumarían 100% y
    // dirían que un solo producto es el negocio entero.
    const completo = await productPerformance(db, empresa, RANGO.from, RANGO.to, 100);
    const total = completo.reduce((s, p) => s + p.revenue, 0);
    const [top] = await productPerformance(db, empresa, RANGO.from, RANGO.to, 1);

    expect(top!.revenueSharePct).toBeCloseTo((top!.revenue / total) * 100, 6);
    expect(top!.revenueSharePct).toBeLessThan(100);
  });

  test('un producto que no vendió en la ventana anterior sube, no explota dividiendo entre cero', async () => {
    const filas = await productPerformance(db, empresa, RANGO.from, RANGO.to, 100);
    // Ninguna transacción de este test cae en febrero, así que todos son "nuevos".
    for (const f of filas) {
      expect(f.previousRevenue).toBe(0);
      expect(f.trend).toBe(f.revenue > 0 ? 'up' : 'flat');
    }
  });
});
