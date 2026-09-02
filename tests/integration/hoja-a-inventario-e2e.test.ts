import { describe, expect, test, beforeAll, afterAll, mock } from 'bun:test';
import { randomUUID } from 'node:crypto';
import * as XLSX from 'xlsx';
import { setupTestDatabase, ownerConnection, testOwnerUrl, testAppUrl } from './setup';
import { crearDobleDeCola } from './doble-de-cola';

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * "ESTA HOJA ES MI INVENTARIO" — Y CIERRA UN HUECO MEDIDO Y CONOCIDO
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *
 * *"No solo los campos del dashboard, sino los campos de analítica y los campos de inventario.
 * Todas las opciones en donde registremos data."* (Jose, 2026-09-02)
 *
 * El destino `inventario` completa la lista de pantallas que el dueño puede corregir, y de
 * paso es la salida al hueco que este repo tiene ESCRITO, MEDIDO y sin cerrar:
 *
 *   ⚠️ *"un inventario serializado que ninguna otra hoja referencia entra como GASTO.
 *   `analizarEsquema` solo reconoce una tabla de entidades si otra hoja la referencia; cuando
 *   la facturación no nombra el VIN, nada la apunta y los vehículos en stock llegan al modelo.
 *   Medido: **Q 1.864.500** de egreso que nadie desembolsó."*
 *
 * La nota de ese hueco dice que el arreglo NO es aflojar el esquema del libro —hay un
 * contraejemplo en un test que ya existe—. Esta es la otra salida, y es mejor: no es una
 * heurística más, **lo afirma el dueño**. Ninguna de las dos detecciones automáticas se toca.
 *
 * ═══ POR QUÉ ES DE INTEGRACIÓN ═══
 *
 * Lo que hay que probar es que la hoja CAMBIA DE CAMINO: deja de producir filas de costo y
 * pasa a escribir artículos. Un unitario sobre `mapearInventarioForzado` cubre el mapeo, pero
 * el desvío vive dentro del bucle del worker —arriba de los cinco filtros— y el resultado son
 * filas en `inventory_items`. Las dos mitades solo se ven corriendo contra Postgres.
 *
 * La afirmación es en DOS TIEMPOS y ese orden importa: primero se reproduce el daño (la hoja
 * entra como costo), después se muestra que forzarla lo elimina. Sin el primer tiempo el test
 * pasaría aunque el hueco no existiera, y no estaría midiendo nada.
 */

process.env.DATABASE_URL = testOwnerUrl;
process.env.APP_DATABASE_URL = testAppUrl;

/**
 * Inventario SERIALIZADO: una fila por unidad, identificada por su serie, SIN columna de
 * cantidad. Es la forma de una concesionaria (VIN), una joyería (certificado) o una
 * distribuidora de maquinaria (número de serie) — y la que `mapearColumnasDeInventario` no
 * puede leer, porque exige cantidad.
 *
 * ⚠️ Y NINGUNA OTRA HOJA LA REFERENCIA, que es la condición exacta del hueco: `Ventas` factura
 * por cliente y no nombra el VIN, así que `analizarEsquema` no la ve como tabla de entidades.
 */
const VEHICULOS: [string, string, number, string][] = Array.from({ length: 6 }, (_, i) => [
  `VIN-9BW${11000 + i}`,
  `Modelo ${i}`,
  150_000 + i * 10_000,
  `2026-06-${String(i + 1).padStart(2, '0')}`,
]);
/** Lo que ESTA hoja pondría como egreso si entrara al modelo. Es la cifra del hueco. */
const COSTO_FALSO = VEHICULOS.reduce((s, f) => s + f[2], 0);

const VENTAS: [string, string, number][] = Array.from({ length: 5 }, (_, i) => [
  `2026-07-${String(i + 1).padStart(2, '0')}`,
  `Cliente ${i}`,
  200_000 + i * 1_000,
]);

function libro(): Buffer {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.aoa_to_sheet([['fecha', 'cliente', 'monto'], ...VENTAS]),
    'Ventas',
  );
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.aoa_to_sheet([['vin', 'modelo', 'costo', 'fecha ingreso'], ...VEHICULOS]),
    'Vehiculos',
  );
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}

/*
 * El doble es IGNORANTE a propósito: clasifica bien lo que se le da y no sabe nada de lo que no
 * se le dio. Sobre `Vehiculos` hace lo ÚNICO razonable —costo + fecha + producto es un costo de
 * ventas— que es literalmente lo que hizo el modelo real con CarsGT. Un doble omnisciente
 * taparía justo lo que hay que medir.
 */
const MAPA_VENTAS = {
  date: 0, amount: 2, currency: null, description: null, counterparty: 1, product: null,
  quantity: null, productCategory: null, store: null, dueDate: null, costTotal: null,
  costUnit: null,
}; // prettier-ignore
const MAPA_VEHICULOS = { ...MAPA_VENTAS, date: 3, amount: 2, counterparty: null, product: 1 };

const anthropicReal = await import('@/lib/anthropic');
mock.module('@/lib/anthropic', () => ({
  ...anthropicReal,
  classifySheetRows: async (params: { rows: unknown[][]; sheetName: string }) => {
    const stock = params.sheetName === 'Vehiculos';
    const columns = stock ? MAPA_VEHICULOS : MAPA_VENTAS;
    const veredictos = params.rows.map((row) =>
      typeof row[2] === 'number'
        ? {
            e: 'transaction' as const,
            t: (stock ? 'cogs' : 'revenue') as 'cogs' | 'revenue',
            c: stock ? 'compra_vehiculos' : 'ventas',
            cf: 0.95,
          }
        : { e: 'skip' as const, t: null, c: null, cf: 0 },
    );
    const porIndice = new Map(
      veredictos.map((v, i) => [i, { i, e: v.e, t: v.t, c: v.c, cf: v.cf }]),
    );
    return {
      model: 'claude-sonnet-5',
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      columns,
      unclassifiedRows: [],
      sheetUsable: true,
      unusableReason: null,
      veredictos,
      rows: anthropicReal.construirFilas(
        porIndice as never,
        { rows: params.rows, baseCurrency: 'GTQ' },
        columns as never,
      ),
    };
  },
  estimateCostUsd: () => 0.001,
  DEFAULT_INSIGHT_PROMPT: '',
}));

const s3Real = await import('@/lib/s3');
mock.module('@/lib/s3', () => ({ ...s3Real, downloadObject: async () => libro() }));

type Handler = (p: { documentId: string; companyId: string }) => Promise<void>;
let handler: Handler | undefined;
const dobleDeCola = crearDobleDeCola();
mock.module('@/queue', () => ({
  ...dobleDeCola.modulo,
  registerWorker: async (queue: string, h: Handler) => {
    handler = h;
    return dobleDeCola.modulo.registerWorker(queue, h as never);
  },
}));

const { startExcelIngestWorker } = await import('@/queue/workers/excel-ingest');

const SUFIJO = randomUUID().slice(0, 8);
const owner = ownerConnection();
let companyId: string;
let userId: string;

/** Una carga nueva del MISMO libro, con los overrides que se le quieran poner. */
async function cargar(overrides: object | null): Promise<string> {
  const [d] = await owner`
    insert into documents (company_id, uploaded_by, s3_key, original_filename,
                           file_size_bytes, mime_type, status, sheet_overrides)
    values (${companyId}, ${userId}, ${`${companyId}/stock-${randomUUID().slice(0, 6)}.xlsx`},
            'stock.xlsx', 100, 'text/csv', 'queued',
            ${overrides ? owner.json(overrides as never) : null})
    returning id`;
  const id = d!.id as string;
  await handler!({ documentId: id, companyId });
  return id;
}

const costoDe = async (documentId: string, hoja: string) =>
  Number(
    (
      await owner`
        select coalesce(sum((payload->>'originalAmount')::numeric), 0) as t
          from staging_rows
         where document_id = ${documentId} and sheet_name = ${hoja}
           and payload->>'type' = 'cogs'`
    )[0]!.t,
  );

beforeAll(async () => {
  await setupTestDatabase();
  const [c] = await owner`
    insert into companies (workos_org_id, name, industry, base_currency)
    values (${`wos_inv_${SUFIJO}`}, ${`Inventario ${SUFIJO}`}, 'retail', 'GTQ') returning id`;
  companyId = c!.id;
  const [u] = await owner`
    insert into users (workos_user_id, email)
    values (${`wos_inv_u_${SUFIJO}`}, ${`inv-${SUFIJO}@test.local`}) returning id`;
  userId = u!.id;
  await startExcelIngestWorker();
});

afterAll(async () => {
  await owner?.end();
});

describe('el dueño manda una hoja al INVENTARIO', () => {
  let sinOverride: string;

  test('PRIMER TIEMPO: sin decir nada, el stock entra como COSTO que nadie desembolsó', async () => {
    /*
     * El hueco, reproducido. Nada lo para: la hoja tiene fecha, costo y producto, así que pasa
     * el dedup, la forma, el catálogo y el filtro de supervivencia, y el modelo la lee —con
     * criterio— como costo de ventas. Sin este tiempo el test pasaría aunque el hueco no
     * existiera.
     */
    sinOverride = await cargar(null);
    expect(await costoDe(sinOverride, 'Vehiculos')).toBe(COSTO_FALSO);

    // Y su inventario queda VACÍO: los vehículos que sí tiene en el patio no están en ningún lado.
    const [{ n }] = await owner`
      select count(*)::int as n from inventory_items where company_id = ${companyId}`;
    expect(Number(n)).toBe(0);
  });

  test('SEGUNDO TIEMPO: forzada a inventario, el costo falso desaparece', async () => {
    const doc = await cargar({ destino: { Vehiculos: 'inventario' } });

    // Ni una fila de esa hoja: no va al modelo, así que no puede producir un movimiento.
    const [{ n }] = await owner`
      select count(*)::int as n from staging_rows
       where document_id = ${doc} and sheet_name = 'Vehiculos'`;
    expect(Number(n)).toBe(0);
    expect(await costoDe(doc, 'Vehiculos')).toBe(0);
  });

  test('…y los vehículos aparecen en el inventario, UNA unidad por serie', async () => {
    /*
     * El camino serializado: sin columna de cantidad, cada fila vale UNA unidad — un VIN es un
     * vehículo. Contarlo de otra forma daría el stock equivocado en la única pantalla que el
     * dueño abre para saber qué tiene.
     */
    const items = await owner`
      select sku, quantity_on_hand::numeric as q from inventory_items
       where company_id = ${companyId} and deleted_at is null order by sku`;
    expect(items.length).toBe(VEHICULOS.length);
    expect(items.map((i) => i.sku)).toEqual(VEHICULOS.map((v) => v[0]).sort());
    for (const i of items) expect(Number(i.q)).toBe(1);
  });

  test('⚠️ la hoja de VENTAS sigue intacta: forzar una no toca a las otras', async () => {
    /*
     * El override es por HOJA. Si arrastrara al resto del libro, el dueño arreglaría su
     * inventario perdiendo su facturación — que es peor que el problema que vino a resolver.
     */
    const doc = await cargar({ destino: { Vehiculos: 'inventario' } });
    const [{ t }] = await owner`
      select coalesce(sum((payload->>'originalAmount')::numeric), 0) as t
        from staging_rows
       where document_id = ${doc} and sheet_name = 'Ventas' and payload->>'type' = 'revenue'`;
    expect(Number(t)).toBe(VENTAS.reduce((s, v) => s + v[2], 0));
  });
});
