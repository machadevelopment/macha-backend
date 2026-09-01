import { describe, expect, test, beforeAll, afterAll, mock } from 'bun:test';
import { randomUUID } from 'node:crypto';
import * as XLSX from 'xlsx';
import { setupTestDatabase, ownerConnection, testOwnerUrl, testAppUrl } from './setup';
import { crearDobleDeCola } from './doble-de-cola';

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * EL RESCATE DE UNA HOJA DESCARTADA, CONTRA EL WORKER DE VERDAD (migración 0043)
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *
 * `corregir-hoja.test.ts` prueba que el endpoint ESCRIBE la corrección. Eso no sirve de nada si
 * el worker no la lee, y esa mitad no se puede ver desde el endpoint: los cuatro puntos donde
 * una hoja se descarta están dentro del bucle del worker, y cada uno es una condición distinta.
 *
 * **Perder una hoja en silencio es el fallo más caro que tiene esta ingesta** —el dashboard de
 * KapePrueba en cero con la contabilidad bien leída, la cartera de clientes que el filtro de
 * catálogo se llevó puesta—. El portón (0042) por fin se lo ENSEÑA al dueño; esto es lo que le
 * da salida.
 *
 * El libro trae una `CarteraClientes` que `firmaDeCatalogo` reconoce y descarta, que es
 * exactamente el descarte que costó Q 13.362 en producción. La afirmación es en dos tiempos:
 * primero que se descarta (o el test no probaría nada), después que forzarla la recupera **con
 * su dinero**, que es lo único que el cliente puede desmentir.
 */

process.env.DATABASE_URL = testOwnerUrl;
process.env.APP_DATABASE_URL = testAppUrl;

const VENTAS: [string, string, number][] = Array.from({ length: 10 }, (_, i) => [
  `2026-07-${String(i + 1).padStart(2, '0')}`,
  `Cliente ${i % 3}`,
  500 + i * 10,
]);

/**
 * La hoja que el pre-filtro se lleva: encabezados de FICHA de contraparte (nombre, NIT,
 * teléfono, condiciones) con una columna acumulada al final. Es la forma de `Clientes_B2B` de
 * KapePrueba, que llegó al modelo y produjo ingresos falsos hasta que la firma la reconoció.
 */
const CARTERA: [string, string, string, string, number][] = Array.from({ length: 6 }, (_, i) => [
  `Cliente ${i}`,
  `NIT-${1000 + i}`,
  `5555-000${i}`,
  '30 días',
  2000 + i * 100,
]);
const TOTAL_CARTERA = CARTERA.reduce((s, f) => s + f[4], 0);

function libro(): Buffer {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.aoa_to_sheet([['fecha', 'cliente', 'monto'], ...VENTAS]),
    'Ventas',
  );
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.aoa_to_sheet([
      ['nombre', 'nit', 'telefono', 'condiciones', 'saldo por cobrar'],
      ...CARTERA,
    ]),
    'CarteraClientes',
  );
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}

/**
 * El doble es IGNORANTE a propósito, igual que el de `lib/hostiles`: clasifica bien lo que se
 * le da y no sabe nada de lo que no se le dio. Sobre la cartera hace lo ÚNICO que puede hacer
 * —leer la última columna como monto— que es literalmente lo que hizo el modelo real en
 * producción. Un doble omnisciente taparía justo lo que hay que medir.
 */
const MAPA_VENTAS = {
  date: 0, amount: 2, currency: null, description: null, counterparty: 1, product: null,
  quantity: null, productCategory: null, store: null, dueDate: null, costTotal: null,
  costUnit: null,
}; // prettier-ignore
const MAPA_CARTERA = { ...MAPA_VENTAS, date: null, amount: 4, counterparty: 0 };

const anthropicReal = await import('@/lib/anthropic');
mock.module('@/lib/anthropic', () => ({
  ...anthropicReal,
  classifySheetRows: async (params: { rows: unknown[][]; sheetName: string }) => {
    const cartera = params.sheetName === 'CarteraClientes';
    const columns = cartera ? MAPA_CARTERA : MAPA_VENTAS;
    /*
     * El ENCABEZADO viaja en el lote igual que en la corrida real, y el modelo lo declara
     * `skip`. El doble tiene que hacer lo mismo o el test contaría una fila de más en cada
     * hoja — y peor, un total que no es el del archivo.
     */
    const veredictos = params.rows.map((row) =>
      typeof row[cartera ? 4 : 2] === 'number'
        ? {
            e: 'transaction' as const,
            t: 'revenue' as const,
            c: cartera ? 'cartera' : 'ventas',
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
let documentId: string;

const filasDe = async (hoja: string) =>
  Number(
    (
      await owner`select count(*)::int as n from staging_rows
                  where document_id = ${documentId} and sheet_name = ${hoja}`
    )[0]!.n,
  );

beforeAll(async () => {
  await setupTestDatabase();
  const [c] = await owner`
    insert into companies (workos_org_id, name, industry, base_currency)
    values (${`wos_rescate_${SUFIJO}`}, ${`Rescate ${SUFIJO}`}, 'retail', 'GTQ') returning id`;
  companyId = c!.id;
  const [u] = await owner`
    insert into users (workos_user_id, email)
    values (${`wos_rescate_u_${SUFIJO}`}, ${`rescate-${SUFIJO}@test.local`}) returning id`;
  await startExcelIngestWorker();
  const [d] = await owner`
    insert into documents (company_id, uploaded_by, s3_key, original_filename,
                           file_size_bytes, mime_type, status)
    values (${companyId}, ${u!.id}, ${`${companyId}/cartera.xlsx`}, 'cartera.xlsx',
            100, 'text/csv', 'queued')
    returning id`;
  documentId = d!.id;
  await handler!({ documentId, companyId });
});

afterAll(async () => {
  await owner?.end();
});

describe('una hoja descartada se puede rescatar', () => {
  test('de entrada, el pre-filtro se lleva la cartera y su dinero no está', async () => {
    /*
     * Guardia del propio test: si el filtro dejara de descartarla, todo lo de abajo pasaría
     * sin probar el rescate. Y las ventas tienen que estar, o lo que se mediría es un libro
     * que no se leyó.
     */
    expect(await filasDe('Ventas')).toBe(VENTAS.length);
    expect(await filasDe('CarteraClientes')).toBe(0);

    // Y el resumen se lo DICE al dueño, que es lo que le permite desmentirnos.
    const [doc] = await owner`select read_summary as r from documents where id = ${documentId}`;
    const hojas = (doc!.r as { hojas: { nombre: string; estado: string }[] }).hojas;
    expect(hojas.find((h) => h.nombre === 'CarteraClientes')?.estado).toBe('descartada');
  });

  test('con `forzar`, la MISMA corrida la procesa y aterriza su dinero', async () => {
    /*
     * Se escribe la corrección igual que el endpoint y se vuelve a correr el worker: es el
     * camino real, con la salvedad de que acá no hace falta pasar por HTTP —eso ya lo cubre
     * `corregir-hoja.test.ts`— y lo que se mide es que el WORKER la obedezca.
     */
    await owner`
      update documents
         set sheet_overrides = ${owner.json({ forzar: ['CarteraClientes'], columnas: {} })}
       where id = ${documentId}`;
    /*
     * Sus lotes y sus filas se limpian, igual que hace el endpoint. Sin esto la reanudación
     * saltaría la hoja y el rescate no ocurriría nunca — el mismo fallo que el rescate viene a
     * arreglar, ahora causado por nosotros.
     */
    await owner`delete from document_ingest_batches
                 where document_id = ${documentId} and sheet_name = 'CarteraClientes'`;

    await handler!({ documentId, companyId });

    expect(await filasDe('CarteraClientes')).toBe(CARTERA.length);
    // Y con el DINERO que el dueño reconoce: seis filas no prueban nada si el monto salió mal.
    const [suma] = await owner`
      select coalesce(sum((payload->>'originalAmount')::numeric), 0)::float8 as t
        from staging_rows
       where document_id = ${documentId} and sheet_name = 'CarteraClientes'`;
    expect(suma!.t).toBeCloseTo(TOTAL_CARTERA, 2);

    // Las ventas no se duplicaron: la segunda corrida saltó sus lotes ya confirmados.
    expect(await filasDe('Ventas')).toBe(VENTAS.length);
  });

  test('⚠️ el reproceso NO borra del resumen las hojas que no tocó', async () => {
    /*
     * Medido en producción el 2026-09-01, apenas se desplegó el rescate: el portón de
     * `EL-INFIERNO-v43-2027.xlsx` pasó de 18 hojas a 9 y las que desaparecieron eran las
     * principales. Sus filas de staging seguían ahí —la contabilidad no se perdía— pero la
     * ÚNICA pantalla con la que el dueño decide si publicar le mostraba un archivo mutilado.
     *
     * La causa es la reanudación por lote, que es correcta: la segunda corrida salta `Ventas`
     * y por eso nunca llega a `hojasLeidas`. Lo que faltaba era no tirar lo que ya se sabía.
     */
    const [doc] = await owner`select read_summary as r from documents where id = ${documentId}`;
    const hojas = (doc!.r as { hojas: { nombre: string; estado: string }[] }).hojas;
    const porNombre = new Map(hojas.map((h) => [h.nombre, h.estado]));

    // La hoja que ESTA corrida leyó: con su veredicto NUEVO, o el rescate no se vería.
    expect(porNombre.get('CarteraClientes')).toBe('movimientos');
    // Y la que la reanudación saltó: sobrevive con lo que ya se sabía de ella.
    expect(porNombre.get('Ventas')).toBe('movimientos');
  });
});
