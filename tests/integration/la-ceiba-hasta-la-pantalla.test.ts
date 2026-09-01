import { describe, expect, test, beforeAll, afterAll, mock } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { Elysia } from 'elysia';
import { setupTestDatabase, ownerConnection, testOwnerUrl, testAppUrl } from './setup';

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * EL LIBRO DIFÍCIL, HASTA LO QUE EL CLIENTE VE EN CADA PANTALLA
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *
 * `hostiles-al-dashboard.test.ts` llega hasta el LEDGER y define "lo que muestra el dashboard"
 * con un `SELECT` escrito dentro del propio test. Eso deja fuera toda la segunda mitad de la
 * cadena: si `metrics/period` tuviera un borde de fecha mal puesto o le faltara un filtro, ese
 * test seguiría verde. Los defectos encontrados el 2026-08-31 caen los tres en ese hueco.
 *
 * Acá se piden los ENDPOINTS de verdad, por HTTP, con el guard de tenant puesto — los mismos
 * que el navegador del cliente: `/metrics/period` (los KPI y su serie), `/metrics/products`
 * (Ventas por producto), `/metrics/categories`, `/metrics/stores` y `/ar-ap`. Lo único
 * falseado es la firma del JWT.
 *
 * La afirmación que importa es la de la punta: **lo que el cliente ve tiene que ser lo que
 * trae su archivo.** No "lo que quedó en la tabla".
 */

process.env.DATABASE_URL = testOwnerUrl;
process.env.APP_DATABASE_URL = testAppUrl;
process.env.WORKOS_JWKS_URL = 'https://example.invalid/jwks';

mock.module('@/lib/auth', () => ({
  verifyToken: async (token: string) => ({ sub: token }),
}));

const { metricsPeriod, metricsProducts, metricsCategories, metricsStores, arAp } =
  await import('@/modules/metrics');
const { promoteDocument } = await import('@/lib/promotion');
const { insertStagingRows } = await import('@/lib/staging');
const { libroLaCeiba, TASA_USD } = await import('@/lib/hostiles/libro-la-ceiba');
const { correrPipeline } = await import('@/lib/hostiles/pipeline-doble');
const { drizzle } = await import('drizzle-orm/postgres-js');
const schema = await import('@/db/schema');
import type { DB } from '@/db/client';

const app = new Elysia()
  .use(metricsPeriod)
  .use(metricsProducts)
  .use(metricsCategories)
  .use(metricsStores)
  .use(arAp);

const SUFIJO = randomUUID().slice(0, 8);
const WOS_USER = `wos_ceiba_${SUFIJO}`;

/** El libro va de enero a agosto de 2026; se pide ese rango completo. */
const DESDE = '2026-01-01';
const HASTA = '2026-08-31';

const owner = ownerConnection();
let db: DB;
let empresa: string;
let usuario: string;

function pedir(path: string) {
  return app.handle(
    new Request(`http://localhost${path}`, {
      headers: { authorization: `Bearer ${WOS_USER}` },
    }),
  );
}

const json = async <T>(path: string): Promise<T> => {
  const r = await pedir(path);
  expect(r.status).toBe(200);
  return (await r.json()) as T;
};

beforeAll(async () => {
  await setupTestDatabase();
  db = drizzle(owner, { schema }) as unknown as DB;

  const [c] = await owner`
    insert into companies (workos_org_id, name, industry, base_currency)
    values (${`org_ceiba_${SUFIJO}`}, ${`La Ceiba ${SUFIJO}`}, 'retail', 'GTQ')
    returning id`;
  empresa = c!.id as string;

  const sufijoTabla = empresa.replace(/-/g, '_');
  for (const t of ['transactions', 'invoices', 'bills']) {
    await owner.unsafe(
      `create table if not exists "${t}_${sufijoTabla}" partition of ${t}
         for values in ('${empresa}')`,
    );
  }

  const [u] = await owner`
    insert into users (workos_user_id, email)
    values (${WOS_USER}, ${`ceiba-${SUFIJO}@test.local`}) returning id`;
  usuario = u!.id as string;

  await owner`
    insert into company_users (company_id, user_id, role)
    values (${empresa}, ${usuario}, 'owner')`;

  // La facturación viene en dólares: sin tasa vigente no hay `amount_base` que afirmar.
  await owner`
    insert into fx_rates (company_id, base_currency, quote_currency, rate, effective_date)
    values (${empresa}, 'GTQ', 'USD', ${TASA_USD}, '2020-01-01')
    on conflict do nothing`;

  // Un documento por hoja, igual que el worker.
  for (const hoja of correrPipeline(libroLaCeiba()).porHoja) {
    if (hoja.clasificadas.length === 0) continue;
    const [d] = await owner`
      insert into documents (company_id, uploaded_by, s3_key, original_filename,
                             file_size_bytes, mime_type)
      values (${empresa}, ${usuario}, ${`${empresa}/${randomUUID()}`},
              ${`12-la-ceiba.xlsx#${hoja.nombre}`}, 1000,
              'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      returning id`;
    const documentId = d!.id as string;
    await insertStagingRows(db, empresa, documentId, hoja.clasificadas as never);
    await promoteDocument(db, empresa, documentId);
  }
});

afterAll(async () => {
  await owner?.end();
});

const VERDAD = libroLaCeiba().verdad;

/**
 * Lo que suma la columna `Total` de `OrdenesCompra`, leída del propio libro.
 *
 * Se calcula acá en vez de escribirla a mano: es la cifra contra la que se afirma que las
 * cuentas por pagar salen de las facturas RECIBIDAS y no de otra hoja, y una constante escrita
 * a mano se desincroniza la primera vez que alguien toque el generador.
 */
const TOTAL_ORDENES_DE_COMPRA = (() => {
  const hoja = libroLaCeiba().hojas.find(([n]) => n === 'OrdenesCompra')![1];
  return Math.round(hoja.slice(1).reduce((a, f) => a + Number(f[4]), 0) * 100) / 100;
})();

describe('Distribuidora La Ceiba — lo que el cliente ve en cada pantalla', () => {
  test('los KPI del período salen del endpoint real, no de un SELECT del test', async () => {
    const r = await json<{ current: Record<string, number> }>(
      `/metrics/period?from=${DESDE}&to=${HASTA}`,
    );

    /*
     * LAS TRES CIFRAS DE PORTADA, EXACTAS CONTRA LA VERDAD DEL ARCHIVO.
     *
     * El ingreso NO salía exacto cuando se escribió este libro: la hoja `Cobros` (6 recibos
     * contra facturas que `Facturacion` YA devengó) volvía a registrar su ingreso, **+44,9 %**,
     * porque `sheet-relations` exigía 8 valores distintos para creer que una hoja referencia a
     * otra y con 6 recibos el esquema del libro no veía la referencia. Con el umbral en 4
     * —medido: piso del repo, y veredicto idéntico sobre los 10 archivos reales— la guarda "un
     * cobro no es una venta nueva" vuelve a llegar a evaluarse.
     */
    expect(r.current.revenue).toBeCloseTo(VERDAD.revenue, 2);

    // El costo y el gasto sí salen exactos: la venta con costo en la misma línea, la factura
    // recibida que produce su costo, y la matriz de gastos despivotada.
    expect(r.current.cogs).toBeCloseTo(VERDAD.cogs, 2);
    expect(r.current.opex).toBeCloseTo(VERDAD.opex, 2);
  });

  test('Ventas por producto: los cuatro artículos del archivo, con su costo', async () => {
    const r = await json<{
      items: { name: string; revenue: number; cogs: number; units: number; costKnown: boolean }[];
    }>(`/metrics/products?from=${DESDE}&to=${HASTA}&limit=50`);

    // Es la pantalla que en el reporte del café salía vacía. Acá tiene que traer los cuatro.
    expect(r.items.map((p) => p.name).sort()).toEqual([
      'Aceite vegetal 1 L',
      'Detergente 1 kg',
      'Harina de maíz 5 lb',
      'Refresco 2 L',
    ]);

    // Y con costo conocido: sin él la pantalla muestra 100 % de margen en todo.
    expect(r.items.every((p) => p.costKnown)).toBe(true);
    expect(r.items.every((p) => p.units > 0)).toBe(true);
  });

  test('Ventas por tienda: las tres sucursales, no el canal ni el vendedor', async () => {
    const r = await json<{ rows: { name: string; total: number }[]; unattributedTotal: number }>(
      `/metrics/stores?from=${DESDE}&to=${HASTA}`,
    );
    expect(r.rows.map((s) => s.name).sort()).toEqual(['TDA-01', 'TDA-02', 'TDA-03']);
  });

  test('Cuentas por cobrar y por pagar salen de la facturación, no de las ventas', async () => {
    type Buckets = Record<'current' | '1_30' | '31_60' | '61_90' | '90_plus', number>;
    const r = await json<{ ar: Buckets; ap: Buckets }>('/ar-ap');
    const suma = (b: Buckets) => Object.values(b).reduce((a, n) => a + n, 0);

    // 10 facturas emitidas en USD (1.200 … 2.460) = 18.300 USD.
    expect(suma(r.ar)).toBeCloseTo(18_300 * TASA_USD, 2);
    // 12 órdenes de compra recibidas, en quetzales: la misma plata que el costo de compras.
    expect(suma(r.ap)).toBeCloseTo(TOTAL_ORDENES_DE_COMPRA, 2);
  });

  test('las categorías del dashboard son las del archivo', async () => {
    const r = await json<{ rows: { category: string; type: string }[] }>(
      `/metrics/categories?from=${DESDE}&to=${HASTA}`,
    );
    const opex = r.rows.filter((c) => c.type === 'opex').map((c) => c.category);
    // Renta, planilla y marketing son OPEX y NUNCA costo directo: si alguna cayera en `cogs`,
    // el margen bruto de portada saldría hundido.
    expect(opex.length).toBeGreaterThan(0);
    expect(r.rows.some((c) => c.type === 'cogs')).toBe(true);
  });
});
