import { describe, expect, test, beforeAll, afterAll, mock } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { Elysia } from 'elysia';
import { setupTestDatabase, ownerConnection } from './setup';
import { crearDobleDeCola } from './doble-de-cola';

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * EL CLIENTE CONTESTA Y LA CIFRA SE MUEVE (2026-09-01)
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *
 * `construirFilas` deriva el costo de una cuenta por pagar cuando el MODELO da el tipo. Cuando
 * no lo da, la fila llega marcada y la contesta el cliente — y ese camino no derivaba nada: la
 * fila iba a `bills` y `rollups.ts` suma `cogs`/`opex` solo de `transactions`.
 *
 * MEDIDO EN PRODUCCIÓN con `12-la-ceiba.xlsx`: 12 órdenes de compra por **GTQ 56.391,00**, el
 * 82 % del costo real del libro. El cliente contestó "es un costo", las filas marcadas bajaron
 * de 15 a 3, el panel dijo que estaba listo, y el estado de resultados no se movió.
 *
 * Se prueba contra Postgres real porque lo que hay que afirmar es que aparece una FILA NUEVA en
 * `staging_rows`, con su hoja heredada y ya aprobada. Un test de unidad sobre el módulo de
 * derivación (que existe) no puede ver eso.
 */
const dobleDeCola = crearDobleDeCola();
mock.module('@/queue', () => dobleDeCola.modulo);

const { ingestion } = await import('@/modules/ingestion');
const { SIN_DERIVAR } = await import('@/lib/derivacion-de-costo');
const { claveDeConcepto } = await import('@/lib/category-dictionary');

const app = new Elysia().use(ingestion);
const SUFIJO = randomUUID().slice(0, 8);
const WOS_USER = `wos_cxp_${SUFIJO}`;

const pedir = (path: string, init?: RequestInit) =>
  app.handle(
    new Request(`http://localhost/documents${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${WOS_USER}`,
        'content-type': 'application/json',
        ...(init?.headers ?? {}),
      },
    }),
  );

const owner = ownerConnection();
let companyId: string;
let userId: string;
let documentId: string;

/** Las cuatro órdenes de compra del archivo real, con su dinero exacto. */
const ORDENES = [
  { proveedor: 'Proveedor 4', monto: 14547.3 },
  { proveedor: 'Proveedor 3', monto: 14247.6 },
  { proveedor: 'Proveedor 2', monto: 13947.9 },
  { proveedor: 'Proveedor 1', monto: 13648.2 },
];
const TOTAL = 56391.0;

beforeAll(async () => {
  await setupTestDatabase();

  const [c] = await owner`
    insert into companies (workos_org_id, name, industry, base_currency)
    values (${`wos_org_cxp_${SUFIJO}`}, ${`CxP ${SUFIJO}`}, 'retail', 'GTQ') returning id
  `;
  companyId = c!.id;

  const [u] = await owner`
    insert into users (workos_user_id, email)
    values (${WOS_USER}, ${`cxp-${SUFIJO}@test.local`}) returning id
  `;
  userId = u!.id;

  await owner`
    insert into company_users (company_id, user_id, role)
    values (${companyId}, ${userId}, 'owner')
  `;

  const [d] = await owner`
    insert into documents (company_id, uploaded_by, s3_key, original_filename,
                           file_size_bytes, mime_type, status, row_count, flagged_count)
    values (${companyId}, ${userId}, ${`${companyId}/oc.xlsx`}, 'oc.xlsx',
            100, 'application/vnd.ms-excel', 'promoted', 6, 6) returning id
  `;
  documentId = d!.id;

  const bill = (proveedor: string, monto: number, extra: Record<string, unknown> = {}) => ({
    counterparty: proveedor,
    issueDate: '2026-04-15',
    dueDate: '2026-05-15',
    originalAmount: monto,
    originalCurrency: 'GTQ',
    ...extra,
  });

  for (const o of ORDENES) {
    await owner`
      insert into staging_rows (company_id, document_id, target_entity, payload, confidence,
                                flag_reason, review_status, sheet_name)
      values (${companyId}, ${documentId}, 'bill', ${owner.json(bill(o.proveedor, o.monto))},
              0.40, 'missing_category', 'pending', 'OrdenesCompra')
    `;
  }

  // Su costo YA lo derivó la ingesta (el modelo dio el tipo) y aun así cayó a revisión por
  // confianza baja. Derivarlo otra vez lo contaría dos veces.
  await owner`
    insert into staging_rows (company_id, document_id, target_entity, payload, confidence,
                              flag_reason, review_status, sheet_name)
    values (${companyId}, ${documentId}, 'bill',
            ${owner.json(bill('Proveedor Ya Derivado', 5000, { type: 'cogs' }))},
            0.40, 'low_confidence:0.40', 'pending', 'OrdenesCompra')
  `;

  // La ingesta SUPRIMIÓ su derivación: el libro ya registra esa compra en otra hoja.
  await owner`
    insert into staging_rows (company_id, document_id, target_entity, payload, confidence,
                              flag_reason, review_status, sheet_name)
    values (${companyId}, ${documentId}, 'bill',
            ${owner.json(bill('Proveedor Ya Contado', 9000, { [SIN_DERIVAR]: true }))},
            0.40, 'missing_category', 'pending', 'OrdenesCompra')
  `;
});

afterAll(async () => {
  await owner?.end();
});

const costos = () => owner`
  select payload, review_status, sheet_name from staging_rows
  where company_id = ${companyId} and target_entity = 'transaction'
`;

describe('contestar una cuenta por pagar produce su costo', () => {
  test('las 12 órdenes de compra recuperan sus GTQ 56.391,00 exactos', async () => {
    const respuestas = ORDENES.map((o) => ({
      concepto: claveDeConcepto(o.proveedor)!,
      type: 'cogs' as const,
      category: 'compras de mercaderia',
    }));

    const r = await pedir(`/${documentId}/conceptos`, {
      method: 'POST',
      body: JSON.stringify({ respuestas }),
    });
    expect(r.status).toBe(200);

    const derivadas = await costos();
    expect(derivadas).toHaveLength(ORDENES.length);

    const total = derivadas.reduce(
      (suma, f) => suma + Number((f.payload as Record<string, unknown>).originalAmount),
      0,
    );
    // La cifra que el cliente no veía. Si esto se rompe, su margen bruto vuelve a mentir.
    expect(total).toBeCloseTo(TOTAL, 2);
  });

  test('la fila derivada queda APROBADA y hereda su hoja', async () => {
    const derivadas = await costos();
    for (const f of derivadas) {
      // Sin `approved` la promoción no la levanta y el arreglo no sirve de nada.
      expect(f.review_status).toBe('approved');
      // Sin la hoja, el cuadre por hoja (migración 0039) reportaría descuadre en las dos.
      expect(f.sheet_name).toBe('OrdenesCompra');
      const p = f.payload as Record<string, unknown>;
      expect(p.type).toBe('cogs');
      expect(p.category).toBe('compras de mercaderia');
      // La fecha es la de EMISIÓN: el vencimiento movería el costo de período.
      expect(p.date).toBe('2026-04-15');
    }
  });

  test('NO se deriva la que la ingesta ya derivó ni la que suprimió a propósito', async () => {
    const r = await pedir(`/${documentId}/conceptos`, {
      method: 'POST',
      body: JSON.stringify({
        respuestas: [
          { concepto: claveDeConcepto('Proveedor Ya Derivado')!, type: 'cogs', category: 'x' },
          { concepto: claveDeConcepto('Proveedor Ya Contado')!, type: 'cogs', category: 'x' },
        ],
      }),
    });
    expect(r.status).toBe(200);

    const derivadas = await costos();
    // Siguen siendo solo las cuatro: ni el doble conteo del modelo ni el del libro.
    expect(derivadas).toHaveLength(ORDENES.length);
    const total = derivadas.reduce(
      (suma, f) => suma + Number((f.payload as Record<string, unknown>).originalAmount),
      0,
    );
    expect(total).toBeCloseTo(TOTAL, 2);
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * UNA FILA QUE LA RESPUESTA NO ARREGLA NO PUEDE TUMBAR A LAS DEMÁS (2026-09-01)
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *
 * MEDIDO EN PRODUCCIÓN con `libro-el-infierno`: una venta en EUR —moneda que no manejamos,
 * conservada a propósito para que se marque— llegó con confianza baja, así que
 * `evaluateFlagReason` devolvió `low_confidence` ANTES de mirar la moneda y su problema real
 * quedó escondido. Se ofreció como concepto, el cliente la contestó, y la respuesta le limpió
 * la marca. Al promover, `resolveFxRate` no encontró tasa para EUR y **lanzó**: la promoción
 * es UNA transacción, así que se cayó la de las otras 17 filas resueltas.
 *
 * El cliente vio los conceptos vaciarse, el dashboard sin moverse y ningún error en ninguna
 * parte. Contestó 18 cosas y no aterrizó ni una — que es exactamente el fallo que toda esta
 * pantalla existe para eliminar.
 */
describe('la fila que no se arregla contestando no se ofrece ni se desmarca', () => {
  const SUF = randomUUID().slice(0, 8);
  let docId: string;

  test('preparar: una cuenta por pagar sana y una venta en EUR, las dos con confianza baja', async () => {
    const [d] = await owner`
      insert into documents (company_id, uploaded_by, s3_key, original_filename,
                             file_size_bytes, mime_type, status, row_count, flagged_count)
      values (${companyId}, ${userId}, ${`${companyId}/eur-${SUF}.xlsx`}, ${`eur-${SUF}.xlsx`},
              100, 'application/vnd.ms-excel', 'promoted', 2, 2) returning id
    `;
    docId = d!.id;

    await owner`
      insert into staging_rows (company_id, document_id, target_entity, payload, confidence,
                                flag_reason, review_status, sheet_name)
      values (${companyId}, ${docId}, 'bill', ${owner.json({
        counterparty: 'Proveedor Sano',
        issueDate: '2026-04-15',
        dueDate: '2026-05-15',
        originalAmount: 4200,
        originalCurrency: 'GTQ',
      })}, 0.40, 'low_confidence:0.40', 'pending', 'OrdenesCompra')
    `;

    // La venta en EUR: su motivo VISIBLE es la confianza, y el real es la moneda.
    await owner`
      insert into staging_rows (company_id, document_id, target_entity, payload, confidence,
                                flag_reason, review_status, sheet_name)
      values (${companyId}, ${docId}, 'transaction', ${owner.json({
        type: 'revenue',
        category: null,
        date: '2026-04-20',
        description: 'Venta en euros',
        originalAmount: 220,
        originalCurrency: 'EUR',
      })}, 0.40, 'low_confidence:0.40', 'pending', 'Ventas')
    `;
  });

  test('el GET NO ofrece la fila en EUR: contestarla no la deja lista', async () => {
    const r = await pedir(`/${docId}/conceptos-pendientes`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { conceptos: { ejemplo: string }[] };
    const ejemplos = body.conceptos.map((c) => c.ejemplo);

    expect(ejemplos).toContain('Proveedor Sano');
    // Pedirle una categoría para esto es pedirle una respuesta que no cambia nada, y dejarle
    // la impresión de que lo resolvió.
    expect(ejemplos).not.toContain('Venta en euros');
  });

  test('el POST tampoco la desmarca aunque se la manden a la fuerza', async () => {
    const r = await pedir(`/${docId}/conceptos`, {
      method: 'POST',
      body: JSON.stringify({
        respuestas: [
          { concepto: claveDeConcepto('Proveedor Sano')!, type: 'cogs', category: 'mercaderia' },
          { concepto: claveDeConcepto('Venta en euros')!, type: 'revenue', category: 'ventas' },
        ],
      }),
    });
    expect(r.status).toBe(200);

    const filas = await owner`
      select payload->>'originalCurrency' as moneda, review_status, flag_reason
      from staging_rows where document_id = ${docId}
    `;
    const eur = filas.find((f) => f.moneda === 'EUR')!;
    const gtq = filas.find((f) => f.moneda === 'GTQ')!;

    // La sana se resuelve y queda promovible: su dinero tiene que aterrizar.
    expect(gtq.review_status).toBe('approved');
    expect(gtq.flag_reason).toBeNull();

    /*
     * Y la de EUR sigue marcada. Es lo que impide que `resolveFxRate` lance dentro de la
     * transacción de promoción y se lleve por delante a la de al lado.
     */
    expect(eur.review_status).toBe('pending');
    expect(eur.flag_reason).not.toBeNull();
  });
});
