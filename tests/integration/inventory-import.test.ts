import { describe, expect, test, beforeAll, afterAll } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/postgres-js';
import { setupTestDatabase, ownerConnection } from './setup';
import * as schema from '@/db/schema';
import { importarInventario } from '@/lib/inventory-import';

/**
 * Importar el inventario del cliente desde su Excel, contra Postgres real
 * (CU-868krkfrh · CU-868krmrcj fase B′).
 *
 * Se prueba acá porque lo que puede salir mal son SALDOS, y el saldo lo calcula la base:
 * `quantity_on_hand` se actualiza con aritmética en SQL sobre la fila bloqueada, no leyendo
 * y reescribiendo en JS. Un mock no reproduciría eso — reproduciría lo que le pidamos.
 *
 * El caso que de verdad importa es la RESUBIDA. El cliente sube su contabilidad completa cada
 * semana: si cada carga insertara una entrada por la cantidad del archivo, el stock se
 * duplicaría cada lunes.
 */
describe('importación de inventario desde el Excel', () => {
  let owner: ReturnType<typeof ownerConnection>;
  const empresa = randomUUID();
  const usuario = randomUUID();

  // Los encabezados de la hoja "Inventario" que traen los archivos reales de los clientes.
  const HEADER = ['ID_Insumo', 'Insumo', 'Unidad de Medida', 'Stock Actual', 'Stock Mínimo'];

  beforeAll(async () => {
    await setupTestDatabase();
    owner = ownerConnection();
    await owner`
      insert into companies (id, workos_org_id, name, industry, base_currency, locale)
      values (${empresa}, ${'org_' + empresa}, ${'Inv ' + empresa}, 'retail', 'GTQ', 'es')
    `;
    await owner`
      insert into users (id, workos_user_id, email, name)
      values (${usuario}, ${'wu_' + usuario}, ${usuario + '@test.local'}, 'Importador')
    `;
  });

  afterAll(async () => {
    await owner?.end();
  });

  const db = () => drizzle(owner, { schema });

  const importar = (rows: unknown[][]) =>
    importarInventario(db(), {
      companyId: empresa,
      userId: usuario,
      headerRow: HEADER,
      rows,
      baseCurrency: 'GTQ',
    });

  const existencia = async (sku: string) => {
    const [f] = await owner`
      select quantity_on_hand::float8 as q from inventory_items
      where company_id = ${empresa} and lower(sku) = ${sku.toLowerCase()}
    `;
    return f?.q ?? null;
  };

  test('la primera carga da de alta los artículos con su existencia', async () => {
    const r = await importar([
      ['INS-001', 'Café en grano', 'kg', 40, 10],
      ['INS-002', 'Leche entera', 'lt', 25, 5],
    ]);
    expect(r).toEqual({ creados: 2, ajustados: 0, sinCambio: 0, omitidas: 0 });
    expect(await existencia('INS-001')).toBe(40);
    expect(await existencia('INS-002')).toBe(25);
  });

  test('la existencia inicial entra como MOVIMIENTO, no como un número suelto', async () => {
    // Es la mitad del contrato del inventario: todo saldo tiene un movimiento que lo
    // explica. Si el import escribiera la columna, habría 40 unidades que nada justifica.
    const movimientos = await owner`
      select m.movement_type, m.quantity::float8 as q
      from inventory_movements m
      join inventory_items i on i.id = m.item_id
      where m.company_id = ${empresa} and i.sku = 'INS-001'
    `;
    expect(movimientos).toHaveLength(1);
    expect(movimientos[0]).toMatchObject({ movement_type: 'in', q: 40 });
  });

  test('RESUBIR EL MISMO ARCHIVO no cambia nada — el caso semanal', async () => {
    // Sin esto, el stock del cliente se duplicaría cada lunes. La cantidad del archivo es un
    // CONTEO ("hoy tengo 40"), no un movimiento ("entraron 40").
    const r = await importar([
      ['INS-001', 'Café en grano', 'kg', 40, 10],
      ['INS-002', 'Leche entera', 'lt', 25, 5],
    ]);
    expect(r).toEqual({ creados: 0, ajustados: 0, sinCambio: 2, omitidas: 0 });
    expect(await existencia('INS-001')).toBe(40);
    expect(await existencia('INS-002')).toBe(25);
  });

  test('un conteo distinto se registra como AJUSTE por la diferencia', async () => {
    const r = await importar([['INS-001', 'Café en grano', 'kg', 33, 10]]);
    expect(r).toEqual({ creados: 0, ajustados: 1, sinCambio: 0, omitidas: 0 });
    expect(await existencia('INS-001')).toBe(33);

    const [ajuste] = await owner`
      select m.movement_type, m.quantity::float8 as q, m.quantity_after::float8 as despues, m.reason
      from inventory_movements m
      join inventory_items i on i.id = m.item_id
      where m.company_id = ${empresa} and i.sku = 'INS-001' and m.movement_type = 'adjustment'
    `;
    // El signo lo lleva la cantidad del ajuste: bajó de 40 a 33.
    expect(ajuste).toMatchObject({ movement_type: 'adjustment', q: -7, despues: 33 });
    // El motivo es lo que contesta "¿de dónde salió esto?" dentro de seis meses.
    expect(String(ajuste!.reason)).toContain('40');
    expect(String(ajuste!.reason)).toContain('33');
  });

  test('un artículo nuevo en una carga posterior se da de alta sin tocar los demás', async () => {
    const r = await importar([
      ['INS-001', 'Café en grano', 'kg', 33, 10],
      ['INS-003', 'Azúcar', 'kg', 12, 4],
    ]);
    expect(r).toEqual({ creados: 1, ajustados: 0, sinCambio: 1, omitidas: 0 });
    expect(await existencia('INS-003')).toBe(12);
    expect(await existencia('INS-001')).toBe(33);
  });

  test('las filas ilegibles se omiten y se CUENTAN, no se inventan', async () => {
    const r = await importar([
      ['INS-004', 'Sin cantidad', 'kg', null, 1],
      [null, null, 'kg', 5, 1], // ni SKU ni nombre: no hay a qué atribuir las 5 unidades
      ['INS-005', 'Cantidad negativa', 'kg', -3, 1],
      ['INS-006', 'Válida', 'kg', 7, 1],
    ]);
    expect(r).toEqual({ creados: 1, ajustados: 0, sinCambio: 0, omitidas: 3 });
    expect(await existencia('INS-006')).toBe(7);
    // Lo que no se pudo leer NO entró: nada de artículos fantasma con stock cero.
    expect(await existencia('INS-004')).toBeNull();
  });

  test('una fila SIN SKU pero CON nombre sí entra, identificada por el nombre', async () => {
    // Es el cliente que lleva su bodega por nombre de producto, común en una PYME. La
    // primera versión de este test daba esta fila por "ilegible" y estaba equivocado: sin
    // este camino, ese cliente no podría importar su inventario nunca.
    const r = await importar([[null, 'Canela en raja', 'kg', 3, 1]]);
    expect(r).toEqual({ creados: 1, ajustados: 0, sinCambio: 0, omitidas: 0 });
    expect(await existencia('Canela en raja')).toBe(3);
  });

  test('el saldo sigue siendo el doblez de su ledger', async () => {
    // La comprobación que resume todo el módulo: sumar los movimientos tiene que dar
    // exactamente la existencia guardada. Si algún camino escribiera la columna por su
    // cuenta, acá se vería.
    const filas = await owner`
      select i.sku,
             i.quantity_on_hand::float8 as saldo,
             coalesce(sum(
               case when m.movement_type = 'out' then -m.quantity else m.quantity end
             ), 0)::float8 as suma
      from inventory_items i
      left join inventory_movements m on m.item_id = i.id
      where i.company_id = ${empresa}
      group by i.sku, i.quantity_on_hand
    `;
    expect(filas.length).toBeGreaterThan(0);
    for (const f of filas) expect(f.saldo).toBe(f.suma);
  });
});
