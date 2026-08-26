import { describe, expect, test, beforeAll, afterAll } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/postgres-js';
import { ownerConnection, setupTestDatabase } from './setup';
import * as schema from '@/db/schema';
import { construirFilas } from '@/lib/anthropic';
import { promoteDocument } from '@/lib/promotion';
import { insertStagingRows } from '@/lib/staging';
import { medirFilas } from '@/lib/reconciliation';
import type { ColumnMap } from '@/lib/row-assembly';
import type { DB } from '@/db/client';

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * DEL EXCEL AL LEDGER: ¿LLEGA LA MISMA PLATA QUE TRAÍA EL ARCHIVO?
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *
 * Cada etapa del pipeline tiene sus tests, y aun así los fallos reportados por clientes
 * atraviesan varias: el dato se lee bien, se clasifica bien, y algo aguas abajo lo mueve, lo
 * duplica o lo pierde. Este test cierra ese hueco — toma filas como las que trae un archivo
 * real, las pasa por el armado y la promoción de verdad, y compara el total del ledger contra
 * el total del archivo.
 *
 * Va contra Postgres real porque lo que se está afirmando lo calcula la base: la conversión de
 * moneda al promover, las particiones por empresa, la idempotencia por fila.
 *
 * Los casos son los que ROMPIERON el sistema en el corpus de dieciséis libros (2026-08-25).
 */
describe('del Excel al ledger', () => {
  let owner: ReturnType<typeof ownerConnection>;
  let db: DB;
  let empresa: string;
  let usuario: string;

  const MAPA_BASE: ColumnMap = {
    date: null,
    amount: null,
    currency: null,
    description: null,
    counterparty: null,
    product: null,
    quantity: null,
    productCategory: null,
    store: null,
    dueDate: null,
    costTotal: null,
    costUnit: null,
  };

  beforeAll(async () => {
    await setupTestDatabase();
    owner = ownerConnection();
    db = drizzle(owner, { schema }) as unknown as DB;

    // Identificadores únicos: los tests de integración comparten la misma base.
    const sufijo = randomUUID();
    const [c] = await owner`
      insert into companies (workos_org_id, name, industry, base_currency)
      values (${`org_e2e_ledger_${sufijo}`}, ${`E2E Ledger ${sufijo}`}, 'retail', 'GTQ') returning id`;
    empresa = c!.id as string;
    await owner.unsafe(
      `create table if not exists "transactions_${empresa.replace(/-/g, '_')}"
         partition of transactions for values in ('${empresa}')`,
    );
    await owner.unsafe(
      `create table if not exists "invoices_${empresa.replace(/-/g, '_')}"
         partition of invoices for values in ('${empresa}')`,
    );

    const [u] = await owner`
      insert into users (workos_user_id, email)
      values (${`wos_e2e_ledger_${sufijo}`}, ${`e2e_${sufijo}@test.local`}) returning id`;
    usuario = u!.id as string;
  });

  afterAll(async () => {
    await owner?.end();
  });

  /** Un documento nuevo con sus filas ya clasificadas, listo para promover. */
  async function cargar(
    filas: unknown[][],
    columnas: ColumnMap,
    veredicto: { e: string; t: string | null; c: string | null } = {
      e: 'transaction',
      t: 'revenue',
      c: 'ventas',
    },
  ): Promise<{ documentId: string; enviado: number }> {
    const [d] = await owner`
      insert into documents (company_id, uploaded_by, s3_key, original_filename,
                             file_size_bytes, mime_type)
      values (${empresa}, ${usuario}, ${`${empresa}/${randomUUID()}`}, 'libro.xlsx',
              1000, 'text/csv')
      returning id`;
    const documentId = d!.id as string;

    const porIndice = new Map(
      filas.map((_, i) => [i, { i, e: veredicto.e, t: veredicto.t, c: veredicto.c, cf: 0.95 }]),
    );
    // El MISMO camino que usa el worker: los valores se arman indexando la celda.
    const rows = construirFilas(porIndice as never, { rows: filas, baseCurrency: 'GTQ' }, columnas);

    /*
     * `insertStagingRows` y NO un insert directo, y esa es la mitad del valor de este test: es
     * la capa donde corre `evaluateFlagReason`, que marca la fila sin fecha, sin monto o sin
     * categoría. Un insert que la saltara probaría un camino que en producción no existe — y
     * la primera versión de este archivo lo hacía, dando por buena una fila de TOTAL que el
     * sistema real nunca habría promovido.
     */
    await insertStagingRows(db, empresa, documentId, rows as never);

    const medido = medirFilas(filas, columnas, 'GTQ');
    return { documentId, enviado: medido.montos.reduce((s, m) => s + m.total, 0) };
  }

  const enElLedger = async (documentId: string): Promise<number> => {
    const [f] = await owner`
      select coalesce(sum(amount_base), 0)::float8 as total from transactions
      where company_id = ${empresa} and document_id = ${documentId} and deleted_at is null`;
    return f!.total as number;
  };

  /**
   * El caso de la agencia de marketing: fechas `DD/MM/YYYY`.
   *
   * `new Date("01/05/2025")` devuelve el 5 de ENERO. Medido sobre el archivo real: el 41 % de
   * las filas entraba con la fecha invertida —a otro trimestre del dashboard— y el 59 % se
   * marcaba por `invalid_date` y no entraba. Es el fallo más difícil de ver de todos, porque
   * no borra ni inventa plata: la mueve de mes.
   */
  test('una fecha guatemalteca llega al ledger en su mes, y toda la plata llega', async () => {
    const columnas: ColumnMap = { ...MAPA_BASE, date: 1, amount: 4, counterparty: 2 };
    const filas: unknown[][] = [
      ['F-001', '01/05/2025', 'Cliente A', 'Servicio', 1000],
      ['F-002', '25/09/2025', 'Cliente B', 'Servicio', 2000],
      ['F-003', '17/07/2026', 'Cliente C', 'Servicio', 3000],
      ['F-004', '03/12/2025', 'Cliente D', 'Servicio', 4000],
    ];

    const { documentId, enviado } = await cargar(filas, columnas);
    const r = await promoteDocument(db, empresa, documentId);

    expect(r.promoted).toBe(true);
    // Las CUATRO entran: ninguna se pierde por `invalid_date`.
    expect(await enElLedger(documentId)).toBe(enviado);
    expect(enviado).toBe(10_000);

    const fechas = await owner`
      select date::text as f from transactions
      where company_id = ${empresa} and document_id = ${documentId} order by date`;
    expect(fechas.map((x) => x.f)).toEqual([
      '2025-05-01', // 1 de MAYO, no 5 de enero
      '2025-09-25',
      '2025-12-03',
      '2026-07-17',
    ]);
  });

  /**
   * Un renglón de TOTAL al final de la hoja es lo más común en un libro hecho a mano, y su
   * monto es la suma de las filas de arriba: promoverlo duplicaría el período entero.
   *
   * Lo que lo detiene NO es una heurística de "parece un total": es que no tiene fecha, y
   * `staging-rules` rechaza toda fila sin fecha legible. La defensa vale más que la
   * heurística porque no depende de reconocer la palabra "TOTAL" en ningún idioma.
   */
  test('el renglón de TOTAL no llega al ledger', async () => {
    const columnas: ColumnMap = { ...MAPA_BASE, date: 0, amount: 3, description: 2 };
    const reales: unknown[][] = [
      ['05/01/2025', 'C1', 'Venta', 1000],
      ['06/01/2025', 'C2', 'Venta', 2000],
      ['07/01/2025', 'C3', 'Venta', 3000],
    ];
    const conTotales: unknown[][] = [
      ...reales,
      [null, null, 'TOTAL', 6000],
      [null, null, 'IVA 12%', 720],
    ];

    const { documentId } = await cargar(conTotales, columnas);
    await promoteDocument(db, empresa, documentId);

    // Solo las tres reales. El total y el IVA se quedan en staging, marcados.
    expect(await enElLedger(documentId)).toBe(6000);
    const [n] = await owner`
      select count(*)::int as n from transactions
      where company_id = ${empresa} and document_id = ${documentId}`;
    expect(n!.n).toBe(3);
  });

  /**
   * Un archivo que escribe los gastos en negativo. El monto entra en POSITIVO —la dirección
   * la lleva el tipo contable— porque si no, los gastos se cancelarían contra los ingresos y
   * el total del período sería un número que no es ninguno de los dos.
   */
  test('los montos negativos entran en positivo, sin cancelarse', async () => {
    const columnas: ColumnMap = { ...MAPA_BASE, date: 0, amount: 2 };
    const filas: unknown[][] = [
      ['05/01/2025', 'Gasto', -1500],
      ['06/01/2025', 'Gasto', -2500],
    ];

    const { documentId } = await cargar(filas, columnas, {
      e: 'transaction',
      t: 'opex',
      c: 'gastos',
    });
    await promoteDocument(db, empresa, documentId);

    expect(await enElLedger(documentId)).toBe(4000);
  });

  /**
   * La venta con su costo en la misma línea produce DOS transacciones. Es correcto y está
   * documentado — pero significa que el ledger tiene más plata que la columna de monto del
   * archivo, y por eso la reconciliación mide y no bloquea.
   */
  test('la venta con costo produce dos filas: ingreso Y costo', async () => {
    const columnas: ColumnMap = { ...MAPA_BASE, date: 0, amount: 2, costTotal: 3, product: 1 };
    const filas: unknown[][] = [
      ['05/01/2025', 'Corolla', 117_700, 99_384],
      ['06/01/2025', 'Sentra', 136_800, 121_793],
    ];

    const { documentId, enviado } = await cargar(filas, columnas);
    await promoteDocument(db, empresa, documentId);

    expect(enviado).toBe(254_500);
    // El ledger trae ingreso + costo: más que la columna de monto, y es lo correcto.
    expect(await enElLedger(documentId)).toBe(254_500 + 221_177);

    const [ingresos] = await owner`
      select coalesce(sum(amount_base), 0)::float8 as t from transactions
      where company_id = ${empresa} and document_id = ${documentId} and type = 'revenue'`;
    expect(ingresos!.t).toBe(254_500);

    const [costos] = await owner`
      select coalesce(sum(amount_base), 0)::float8 as t from transactions
      where company_id = ${empresa} and document_id = ${documentId} and type = 'cogs'`;
    expect(costos!.t).toBe(221_177);
  });

  /**
   * El cliente resube su contabilidad completa cada semana. Promover dos veces el mismo
   * documento no puede duplicar su plata: la idempotencia es POR FILA (`promoted_at`).
   */
  test('promover dos veces no duplica el ledger', async () => {
    const columnas: ColumnMap = { ...MAPA_BASE, date: 0, amount: 2 };
    const filas: unknown[][] = [
      ['05/01/2025', 'Venta', 5000],
      ['06/01/2025', 'Venta', 7000],
    ];

    const { documentId } = await cargar(filas, columnas);
    await promoteDocument(db, empresa, documentId);
    const primera = await enElLedger(documentId);

    await promoteDocument(db, empresa, documentId);
    expect(await enElLedger(documentId)).toBe(primera);
    expect(primera).toBe(12_000);
  });
});
