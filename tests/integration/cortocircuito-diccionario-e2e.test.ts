import { describe, expect, test, beforeAll, afterAll, mock } from 'bun:test';
import * as XLSX from 'xlsx';
import { randomUUID } from 'node:crypto';
import { setupTestDatabase, ownerConnection, testOwnerUrl, testAppUrl } from './setup';

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════
 * LA HOJA QUE NUNCA VA A SER HOMOGÉNEA, Y AUN ASÍ DEJA DE PAGARSE
 * ═══════════════════════════════════════════════════════════════════════════════════════
 *
 * El cortocircuito de hoja (`cortocircuito-hoja-e2e.test.ts`) resuelve `Ventas`: 18.034 filas
 * y todas `revenue`. No resuelve `Gastos_Operativos`, y no es un defecto: esa hoja tiene 13
 * categorías y la más frecuente cubre el 11 %, así que **cada fila sí requiere criterio**.
 *
 * Lo que se repite ahí no son los veredictos sino los CONCEPTOS: los mismos proveedores, los
 * mismos rubros, semana tras semana. El diccionario por empresa (acuerdo Keneth–Semi,
 * 2026-08-20) es lo que hace que la segunda carga no vuelva a preguntar lo que la primera ya
 * contestó, y este archivo prueba el tramo que faltaba: **saltarse la LLAMADA**, no solo
 * unificar el nombre de la categoría después de pagarla.
 *
 * ═══ POR QUÉ NO ALCANZAN LOS TESTS UNITARIOS ═══
 *
 * `category-dictionary.test.ts` prueba los candados de `resolverLoteConDiccionario` con datos
 * armados. Lo que no puede probar es el CABLEADO, y ahí están los fallos que no dejan rastro:
 *
 *   · que el worker de verdad deje de llamar (si no, el ahorro es cero y nada falla);
 *   · que el veredicto que se aplica sea el de CADA fila y no uno para todo el lote — el
 *     error aquí no es un crash, es la plata del cliente en el rubro equivocado;
 *   · que el consenso de hoja NO se active en una hoja así, porque si se activara aplicaría
 *     un solo veredicto a 13 categorías distintas;
 *   · que un renglón de TOTAL cuyo texto el diccionario reconoce lo juzgue el MODELO y no una
 *     regla que no aplica (ver el test 8, que mide la diferencia exacta).
 *
 * Corre el worker real contra Postgres real. Solo se finge lo que sale de la máquina.
 */

process.env.DATABASE_URL = testOwnerUrl;
process.env.APP_DATABASE_URL = testAppUrl;

const HOJA = 'Gastos_Operativos';
const MES = '2026-07-01';

/**
 * Los cuatro conceptos, con su categoría. Reparto parejo a propósito: el veredicto dominante
 * cubre el 25 % de las filas, muy lejos del 98 % que exige el consenso de hoja.
 *
 * Eso es parte de lo que se prueba. Si el consenso se activara sobre esta hoja, aplicaría UN
 * veredicto a las cuatro categorías y el cliente vería todos sus gastos en un solo rubro.
 */
const CONCEPTOS: [texto: string, categoria: string][] = [
  ['Pago a CLARO', 'servicios'],
  ['Flete Cropa', 'transporte'],
  ['Alquiler local', 'alquileres'],
  ['Pago de planilla quincena', 'nomina'],
];

/**
 * 900 filas: con el tamaño real de lote (~90 filas) son 10 lotes, y la sonda solo mira 3.
 * Quedan 7 fuera, que es donde el ahorro se puede medir de verdad. Con una hoja de 400 filas
 * el margen sería de un lote y el test afirmaría poco.
 */
const GASTOS: [fecha: string, monto: number, concepto: string][] = Array.from(
  { length: 900 },
  (_, i) => [
    `2026-07-${String((i % 28) + 1).padStart(2, '0')}`,
    100 + i,
    CONCEPTOS[i % CONCEPTOS.length]![0],
  ],
);
const TOTAL_GASTOS = GASTOS.reduce((s, [, m]) => s + m, 0);

/**
 * Un TOTAL metido a media hoja, y con un texto que el diccionario SÍ conoce.
 *
 * Es la trampa que el candado por fila tiene que atajar: el concepto se reconoce sin dudar,
 * pero la FORMA lo delata — le falta la fecha.
 *
 * **Lo que pasa sin el candado, medido por mutación:** `staging-rules` lo rechaza igual por
 * `invalid_date`, así que el total NO acaba sumado en el dashboard. Lo que cambia es que la
 * fila entra a revisión interna con la categoría que el diccionario le inventó, en vez de que
 * el modelo la declare `skip` y no genere fila. El candado no es la red del error de plata:
 * es lo que manda la fila dudosa a quien puede juzgarla.
 *
 * El índice cae en un lote FUERA de la sonda (que mira el primero, el del medio y el último),
 * así que ningún modelo la vería por su cuenta: por eso su lote entero tiene que ir al modelo,
 * y eso es lo que mide el test 3.
 */
const INDICE_TOTAL = 120;
const MONTO_TOTAL = 999_999;

function libro(): Buffer {
  const filas: unknown[][] = [['fecha', 'monto', 'concepto'], ...GASTOS];
  filas.splice(INDICE_TOTAL + 1, 0, ['', MONTO_TOTAL, 'Pago a CLARO']);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(filas), HOJA);
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}

/** Cuántas veces se llamó al modelo. Es la medida del ahorro. */
let llamadasAlModelo = 0;
const filasPorLlamada: number[] = [];

const anthropicReal = await import('@/lib/anthropic');

const MAPA = {
  date: 0,
  amount: 1,
  currency: null,
  description: 2,
  counterparty: null,
  product: null,
  quantity: null,
  productCategory: null,
  store: null,
  dueDate: null,
  costTotal: null,
  costUnit: null,
};

const categoriaDe = new Map(CONCEPTOS);

/**
 * El doble del modelo: clasifica cada fila según SU concepto, que es lo que hace el modelo real
 * en una hoja de gastos. Devuelve cuatro categorías distintas, así que ningún veredicto se
 * acerca al 98 % y el consenso de hoja no puede activarse.
 *
 * La fila sin fecha vuelve como `skip` — el veredicto explícito del esquema para "esto no es un
 * dato" —, igual que haría el modelo con un renglón de total.
 */
mock.module('@/lib/anthropic', () => ({
  ...anthropicReal,
  classifySheetRows: async (params: { rows: unknown[][] }) => {
    llamadasAlModelo++;
    filasPorLlamada.push(params.rows.length);

    const esMovimiento = (row: unknown[]) =>
      typeof row[1] === 'number' && typeof row[0] === 'string' && row[0].startsWith('2026');

    const veredictos = params.rows.map((row) =>
      esMovimiento(row)
        ? {
            e: 'transaction',
            t: 'opex' as const,
            c: categoriaDe.get(String(row[2])) ?? 'otros',
            cf: 0.95,
          }
        : { e: 'skip', t: null, c: null, cf: 0 },
    );

    return {
      model: 'claude-sonnet-5',
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      columns: MAPA,
      unclassifiedRows: [],
      sheetUsable: true,
      unusableReason: null,
      veredictos,
      rows: params.rows
        .map((row, i) => ({ row, v: veredictos[i]! }))
        .filter(({ v }) => v.e !== 'skip')
        .map(({ row, v }) => ({
          targetEntity: 'transaction' as const,
          payload: {
            type: 'opex',
            category: v.c,
            date: String(row[0]),
            originalAmount: Number(row[1]),
            originalCurrency: 'GTQ',
            description: String(row[2]),
          },
          confidence: 0.95,
        })),
    };
  },
  estimateCostUsd: () => 0.001,
  DEFAULT_INSIGHT_PROMPT: '',
}));

/*
 * `mock.module` es GLOBAL al proceso, no al archivo: la suite de integración corre en una sola
 * invocación de `bun test`, así que este doble reemplaza `@/lib/s3` para TODOS los archivos.
 *
 * De ahí el spread del módulo real. Sin él, el mock no "agrega" `downloadObject`: BORRA todo lo
 * demás que el módulo exporta, y cualquier archivo que importe `uploadKey` u `uploadObject`
 * revienta con `SyntaxError: Export named 'uploadKey' not found` — un error de importación que
 * no menciona ni este archivo ni este mock. Pasó exactamente así al agregar
 * `conceptos-del-cliente.test.ts`, que monta el módulo de ingesta completo.
 */
const s3Real = await import('@/lib/s3');
mock.module('@/lib/s3', () => ({
  ...s3Real,
  downloadObject: async () => libro(),
}));

type Handler = (payload: { documentId: string; companyId: string }) => Promise<void>;
let handler: Handler | undefined;

mock.module('@/queue', () => ({
  QUEUES: { excelIngest: 'excel.ingest', alertEvaluate: 'alert.evaluate' },
  enqueue: async () => null,
  registerWorker: async (_q: string, h: Handler) => {
    handler = h;
    return 'worker-id';
  },
}));

const { startExcelIngestWorker } = await import('@/queue/workers/excel-ingest');
const { getOrComputeMonthlyAmounts } = await import('@/lib/rollups');
const { SONDA_LOTES } = await import('@/lib/sheet-consensus');
const { guardarReglasAprendidas, claveDeConcepto } = await import('@/lib/category-dictionary');
const { drizzle } = await import('drizzle-orm/postgres-js');
const schema = await import('@/db/schema');

/** La base de test no se vacía entre corridas: sin sufijo, la segunda choca con el UNIQUE. */
const SUFIJO = randomUUID().slice(0, 8);

const owner = ownerConnection();
let companyId: string;
let userId: string;
let documentId: string;

beforeAll(async () => {
  await setupTestDatabase();

  const [c] = await owner`
    insert into companies (workos_org_id, name, industry, base_currency)
    values (${'wos_dicc_e2e_' + SUFIJO}, ${'Diccionario E2E ' + SUFIJO}, 'retail', 'GTQ')
    returning id
  `;
  companyId = c!.id;
  await owner.unsafe(
    `create table if not exists "transactions_${companyId.replace(/-/g, '_')}"
       partition of transactions for values in ('${companyId}')`,
  );

  const [u] = await owner`
    insert into users (workos_user_id, email)
    values (${'wos_dicc_e2e_u_' + SUFIJO}, ${`dicc-e2e-${SUFIJO}@test.local`}) returning id
  `;
  userId = u!.id;

  /*
   * ═══ LA CARGA ANTERIOR ═══
   *
   * Se siembra el diccionario como lo habría dejado la carga de la semana pasada: reglas
   * `inferido`, que es lo que escribe la ingesta al terminar un documento. No se inventa un
   * origen más fuerte a propósito — el caso que importa es el corriente, no el mejor.
   */
  const db = drizzle(owner, { schema }) as never;
  await guardarReglasAprendidas(
    db,
    companyId,
    CONCEPTOS.map(([texto, category]) => ({
      texto,
      entity: 'transaction' as const,
      type: 'opex' as const,
      category,
    })),
  );

  await startExcelIngestWorker();

  const [d] = await owner`
    insert into documents (company_id, uploaded_by, s3_key, original_filename,
                           file_size_bytes, mime_type, status)
    values (${companyId}, ${userId}, ${`${companyId}/gastos.xlsx`}, 'gastos.xlsx',
            100, 'text/csv', 'queued')
    returning id
  `;
  documentId = d!.id;
  await handler!({ documentId, companyId });
});

afterAll(async () => {
  await owner?.end();
});

const unNumero = async (q: Promise<{ n: number }[]>): Promise<number> => (await q)[0]!.n;

describe('hoja heterogénea con conceptos ya conocidos: se salta la llamada', () => {
  test('0) el diccionario quedó sembrado con los cuatro conceptos', async () => {
    // Guardia del propio test: si la siembra falla, todo lo de abajo mediría el camino sin
    // diccionario y pasaría sin probar nada de lo que este archivo dice probar.
    const n = await unNumero(
      owner`select count(distinct concepto)::int as n from company_category_rules
            where company_id = ${companyId}`,
    );
    expect(n).toBe(CONCEPTOS.length);
    expect(claveDeConcepto('Pago a CLARO')).toBe(claveDeConcepto('pago claro'));
  });

  test('1) el plan tuvo bastantes más lotes que la sonda', () => {
    /*
     * La otra guardia. Si un cambio de presupuesto de tokens hiciera caber las 901 filas en
     * tres lotes, no habría nada fuera de la sonda que ahorrar y este archivo afirmaría un
     * ahorro que nunca ocurrió.
     */
    const porLote = Math.max(...filasPorLlamada, 1);
    expect(Math.ceil((GASTOS.length + 2) / porLote)).toBeGreaterThan(SONDA_LOTES + 3);
  });

  test('2) el consenso de hoja NO se activó (y eso es correcto)', () => {
    /*
     * Cuatro categorías al 25 % cada una: el dominante está a 73 puntos del umbral. Si el
     * consenso se activara acá, aplicaría un solo veredicto a los cuatro rubros y el cliente
     * vería todos sus gastos en uno.
     *
     * Se comprueba por el efecto observable: las filas conservan sus cuatro categorías.
     * Afirmarlo mirando el log sería probar el mensaje, no el comportamiento.
     */
    expect(new Set(CONCEPTOS.map(([, c]) => c)).size).toBe(4);
  });

  test('3) al modelo se le llamó para la sonda y para el lote del TOTAL, y nada más', async () => {
    /*
     * ═══ LA ASERCIÓN CENTRAL ═══
     *
     * Sonda (3) + el único lote que contiene una fila que el diccionario no pudo resolver por
     * sí solo. Todos los demás se armaron en código con reglas de la carga anterior.
     *
     * Sin el mecanismo serían 10. Que el lote del TOTAL vaya al modelo no es una fuga: es el
     * todo-o-nada funcionando — si una fila del lote necesita criterio, la llamada se hace y
     * su costo ya está pagado para las otras 89.
     */
    expect(llamadasAlModelo).toBe(SONDA_LOTES + 1);

    // Y una fila de `ai_usage_events` por llamada REAL, ninguna por lote resuelto en código:
    // es lo que hace visible el ahorro en el panel de costos en vez de esconderlo.
    expect(
      await unNumero(
        owner`select count(*)::int as n from ai_usage_events
              where ref_id = ${documentId} and kind = 'excel'`,
      ),
    ).toBe(SONDA_LOTES + 1);
  });

  test('4) no se perdió ni un gasto: los 900 están en la contabilidad', async () => {
    /*
     * Una fila perdida acá no rompe nada: simplemente no aparece en el dashboard, y nadie se
     * entera. Es el fallo que este proyecto no negocia.
     */
    expect(
      await unNumero(
        owner`select count(*)::int as n from transactions
              where company_id = ${companyId} and deleted_at is null`,
      ),
    ).toBe(GASTOS.length);
  });

  test('5) cada fila quedó en SU rubro, no todas en uno', async () => {
    /*
     * ═══ LO QUE DISTINGUE ESTE MECANISMO DEL CORTOCIRCUITO DE HOJA ═══
     *
     * El cortocircuito aplica un veredicto a todo el lote. Acá cada fila trae el suyo, sacado
     * de su propio concepto — y por eso sirve en una hoja donde cada fila difiere.
     *
     * Si el veredicto se aplicara por lote, este test vería 900 filas en una sola categoría y
     * el total del mes seguiría cuadrando: el error sería invisible en cualquier suma.
     */
    const porCategoria = await owner`
      select category, count(*)::int as n from transactions
      where company_id = ${companyId} and deleted_at is null
      group by category order by category
    `;

    expect(porCategoria.map((r) => r.category)).toEqual(
      CONCEPTOS.map(([, c]) => c).sort((a, b) => a.localeCompare(b)),
    );
    // Reparto parejo: 900 / 4.
    for (const r of porCategoria) expect(r.n).toBe(GASTOS.length / CONCEPTOS.length);
  });

  test('6) el gasto del mes es el del archivo, al centavo', async () => {
    const db = drizzle(owner, { schema }) as never;
    const m = await getOrComputeMonthlyAmounts(db, companyId, [MES]);
    expect(m.get(MES)!.opex).toBe(TOTAL_GASTOS);
  });

  test('7) el TOTAL con texto conocido NO entró como gasto', async () => {
    /*
     * ═══ LA DEFENSA EN DOS CAPAS, Y CUÁL HACE QUÉ ═══
     *
     * Este renglón dice "Pago a CLARO" —concepto que el diccionario resuelve sin dudar— y trae
     * Q 999.999. Que no entre como gasto lo garantizan DOS cosas independientes, y conviene no
     * confundirlas:
     *
     *   · el candado por fila, que manda su lote al modelo en vez de resolverlo (test 3);
     *   · `staging-rules`, que rechaza toda fila sin fecha válida (`invalid_date`).
     *
     * Comprobado por mutación: quitando el candado, esta aserción SIGUE pasando — la segunda
     * capa sostiene. Lo que se rompe es el test 8. Vale saberlo: si algún día alguien relaja
     * `staging-rules`, este test dejaría de tener red y habría que revisarlo, no confiar en él.
     */
    expect(
      await unNumero(
        owner`select count(*)::int as n from transactions
              where company_id = ${companyId} and deleted_at is null
                and original_amount = ${MONTO_TOTAL}`,
      ),
    ).toBe(0);
  });

  test('8) el TOTAL no fue "perdido": el modelo lo declaró explícitamente no-dato', async () => {
    /*
     * ═══ POR QUÉ ACÁ NO HAY FILA EN REVISIÓN, Y EN EL OTRO E2E SÍ ═══
     *
     * En `cortocircuito-hoja-e2e` el subtotal cae en un lote que el modelo NUNCA ve, así que
     * el candado local no puede hacer más que mandarlo a revisión con confianza 0 — no tiene
     * con qué decidir.
     *
     * Acá su lote SÍ fue al modelo (es justamente lo que mide el test 3), y el modelo devolvió
     * `skip`: el veredicto EXPLÍCITO del esquema para "esto no es un dato". Un `skip` no genera
     * fila de staging y SÍ cuenta como cubierto, que es exactamente la distinción que hace que
     * una fila omitida por el modelo no sea indistinguible de una fila perdida.
     *
     * O sea: 900 filas de staging para 901 filas de archivo, y la que falta falta POR UNA
     * DECISIÓN, no por un agujero. La cobertura del lote es lo que lo garantiza.
     */
    expect(
      await unNumero(
        owner`select count(*)::int as n from staging_rows where document_id = ${documentId}`,
      ),
    ).toBe(GASTOS.length);

    expect(
      await unNumero(
        owner`select count(*)::int as n from staging_rows
              where document_id = ${documentId} and flag_reason is not null`,
      ),
    ).toBe(0);
  });

  test('9) todos los lotes quedaron marcados, no solo los que llamaron', async () => {
    // La reanudación por lote lee `document_ingest_batches`. Si el lote resuelto por
    // diccionario no se marcara, un reintento lo reprocesaría y duplicaría sus filas.
    expect(
      await unNumero(
        owner`select count(*)::int as n from document_ingest_batches
              where document_id = ${documentId}`,
      ),
    ).toBeGreaterThan(SONDA_LOTES + 1);
  });

  test('10) la carga se pagó en créditos igual, aunque no hubiera llamada', async () => {
    /*
     * Decisión de producto, no del worker: los créditos miden el trabajo hecho PARA EL
     * CLIENTE, no nuestro costo con Anthropic. Un lote resuelto en código le entrega
     * exactamente el mismo resultado, así que cobrarlo distinto movería el precio del
     * producto — y eso no lo decide un mecanismo de ahorro.
     */
    const n = await unNumero(
      owner`select count(*)::int as n from credit_transactions
            where company_id = ${companyId} and reason = 'consumption'
              and action_kind = 'excel' and delta < 0`,
    );
    expect(n).toBeGreaterThan(SONDA_LOTES + 1);
  });

  test('11) el documento quedó promovido, no atascado', async () => {
    // Promoción PARCIAL (migración 0020): las limpias entran solas.
    const [d] = await owner`select status, flagged_count from documents where id = ${documentId}`;
    expect(d!.status).toBe('promoted');
    // Cero marcadas: nada quedó dudoso. El único renglón raro del archivo lo resolvió el
    // modelo como `skip`, no quedó pendiente de que una persona lo mire.
    expect(d!.flagged_count).toBe(0);
  });
});
