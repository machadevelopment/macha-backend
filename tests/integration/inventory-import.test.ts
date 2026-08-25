import { describe, expect, test, beforeAll, afterAll } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/postgres-js';
import { setupTestDatabase, ownerConnection } from './setup';
import * as schema from '@/db/schema';
import { importarInventario, mapearInventarioSerializado } from '@/lib/inventory-import';
import { revertDocument } from '@/lib/promotion';
import { recordMovement } from '@/modules/inventory/service';

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
  let docBase: string;

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

    // Documento al que se atribuyen los movimientos de los tests de importación de arriba.
    // Existe para que `documentId` sea obligatorio en la firma y ningún camino pueda crear
    // movimientos huérfanos que después no se puedan revertir.
    const [base] = await owner`
      insert into documents (company_id, uploaded_by, s3_key, original_filename,
                             file_size_bytes, mime_type, status)
      values (${empresa}, ${usuario}, ${`${empresa}/base`}, 'base.xlsx',
              100, 'text/csv', 'promoted')
      returning id
    `;
    docBase = base!.id;
  });

  afterAll(async () => {
    await owner?.end();
  });

  const db = () => drizzle(owner, { schema });

  const importar = (rows: unknown[][]) =>
    importarInventario(db(), {
      companyId: empresa,
      documentId: docBase,
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

  describe('revertir la carga deshace su inventario', () => {
    test('el stock vuelve atrás con movimientos COMPENSATORIOS, no borrando', async () => {
      /*
       * El hueco que esto tapa: desde que el Excel puede poblar el inventario, revertir una
       * carga devolvía la contabilidad pero dejaba el inventario con los números del archivo
       * malo — para siempre y sin forma de deshacerlo desde la interfaz.
       *
       * Se compensa en vez de borrar porque `inventory_movements` es append-only y porque el
       * movimiento OCURRIÓ: durante un tiempo ese fue el saldo real. La corrección es una fila
       * que explica por qué cambió, no la desaparición de la anterior.
       */
      const [d] = await owner`
        insert into documents (company_id, uploaded_by, s3_key, original_filename,
                               file_size_bytes, mime_type, status)
        values (${empresa}, ${usuario}, ${`${empresa}/inv-revert`}, 'inv.xlsx',
                100, 'text/csv', 'promoted')
        returning id
      `;
      const documentId = d!.id;

      await importarInventario(db(), {
        companyId: empresa,
        documentId,
        userId: usuario,
        headerRow: HEADER,
        rows: [['REV-001', 'Producto a revertir', 'kg', 50, 5]],
        baseCurrency: 'GTQ',
      });
      expect(await existencia('REV-001')).toBe(50);

      await revertDocument(db(), empresa, documentId);

      // El saldo vuelve a cero: la carga que lo puso ya no cuenta.
      expect(await existencia('REV-001')).toBe(0);

      // Y el historial explica por qué, en vez de que el movimiento haya desaparecido.
      const movimientos = await owner`
        select m.movement_type, m.quantity::float8 as q, m.reason
        from inventory_movements m
        join inventory_items i on i.id = m.item_id
        where m.company_id = ${empresa} and i.sku = 'REV-001'
        order by m.created_at
      `;
      expect(movimientos).toHaveLength(2);
      expect(movimientos[0]).toMatchObject({ movement_type: 'in', q: 50 });
      expect(movimientos[1]).toMatchObject({ movement_type: 'adjustment', q: -50 });
      expect(String(movimientos[1]!.reason)).toContain('revirtió');
    });

    test('NO toca los movimientos registrados a mano', async () => {
      // Revertir una carga no puede deshacer el conteo físico que una persona hizo después:
      // ese movimiento no salió de este archivo y su verdad no depende de él.
      const [d] = await owner`
        insert into documents (company_id, uploaded_by, s3_key, original_filename,
                               file_size_bytes, mime_type, status)
        values (${empresa}, ${usuario}, ${`${empresa}/inv-mixto`}, 'mixto.xlsx',
                100, 'text/csv', 'promoted')
        returning id
      `;
      const documentId = d!.id;

      await importarInventario(db(), {
        companyId: empresa,
        documentId,
        userId: usuario,
        headerRow: HEADER,
        rows: [['MIX-001', 'Mixto', 'kg', 20, 2]],
        baseCurrency: 'GTQ',
      });

      // Alguien cuenta la bodega y registra 5 más, a mano.
      const [item] = await owner`
        select id from inventory_items where company_id = ${empresa} and sku = 'MIX-001'
      `;
      await recordMovement(db(), empresa, usuario, {
        itemId: item!.id,
        movementType: 'in',
        quantity: 5,
        reason: 'Conteo físico',
      });
      expect(await existencia('MIX-001')).toBe(25);

      await revertDocument(db(), empresa, documentId);

      // Se van los 20 de la carga; los 5 del conteo manual se quedan.
      expect(await existencia('MIX-001')).toBe(5);
    });

    test('el saldo SIGUE siendo el doblez de su ledger después de revertir', async () => {
      // La comprobación que resume todo: si la compensación tocara el saldo sin escribir su
      // movimiento —o al revés— acá se vería.
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

    test('revertir DOS veces no corrompe el saldo — idempotencia', async () => {
      /*
       * El fallo que esto fija lo encontré revisando mi propio código, no ejecutándolo: las
       * filas compensatorias llevan el mismo `document_id` que las que anulan —tienen que
       * llevarlo, es de dónde salieron—, así que una compensación movimiento-a-movimiento, al
       * correr dos veces, compensaría también sus propias compensaciones y dejaría el saldo
       * corrido.
       *
       * Se resolvió sumando el NETO por artículo: tras la primera pasada el neto de esa carga
       * es cero, y la segunda no escribe nada. Hoy la ruta ya impide revertir dos veces, pero
       * la corrección de un saldo no debe depender de que el llamador se acuerde.
       */
      const [d] = await owner`
        insert into documents (company_id, uploaded_by, s3_key, original_filename,
                               file_size_bytes, mime_type, status)
        values (${empresa}, ${usuario}, ${`${empresa}/doble-revert`}, 'doble.xlsx',
                100, 'text/csv', 'promoted')
        returning id
      `;
      const documentId = d!.id;

      await importarInventario(db(), {
        companyId: empresa,
        documentId,
        userId: usuario,
        headerRow: HEADER,
        rows: [['DOB-001', 'Doble revert', 'kg', 30, 3]],
        baseCurrency: 'GTQ',
      });
      expect(await existencia('DOB-001')).toBe(30);

      await revertDocument(db(), empresa, documentId);
      expect(await existencia('DOB-001')).toBe(0);

      // La segunda no debe restar otros 30 y dejarlo en -30.
      await revertDocument(db(), empresa, documentId);
      expect(await existencia('DOB-001')).toBe(0);

      // Y una tercera tampoco, por si acaso.
      await revertDocument(db(), empresa, documentId);
      expect(await existencia('DOB-001')).toBe(0);

      // El ledger sigue cuadrando después de todo eso.
      const [f] = await owner`
        select i.quantity_on_hand::float8 as saldo,
               coalesce(sum(case when m.movement_type = 'out' then -m.quantity else m.quantity end), 0)::float8 as suma
        from inventory_items i
        left join inventory_movements m on m.item_id = i.id
        where i.company_id = ${empresa} and i.sku = 'DOB-001'
        group by i.quantity_on_hand
      `;
      expect(f!.saldo).toBe(f!.suma);
    });
  });

  /**
   * ═══ UN SKU EN VARIAS TIENDAS SE SUMA, NO SE PISA (auditoría 2026-08-24) ═══
   *
   * El archivo de una joyería trae 210 filas de inventario para 42 productos: una por cada
   * combinación de producto y tienda. Cada fila se trataba como un CONTEO nuevo del mismo
   * artículo y cada una pisaba a la anterior:
   *
   *     JYL-ANI-0001   130 · 42 · 35 · 1 · 0   →  quedaba en 0, donde hay 208
   *
   * El rastro lo dejaba escrito y nadie lo leía: "Conteo importado del archivo (24 → 9)",
   * cuatro veces seguidas para el mismo artículo. Afectaba a empresas reales: 55 artículos de
   * Electro Hogar.
   */
  describe('un mismo SKU repetido por tienda', () => {
    test('las cantidades se SUMAN en vez de pisarse', async () => {
      // Las cinco cantidades reales del archivo de la joyería, para el mismo producto.
      const r = await importar([
        ['JYL-ANI-0001', 'Anillo Aurora', 'unidad', 130, 5],
        ['JYL-ANI-0001', 'Anillo Aurora', 'unidad', 42, 5],
        ['JYL-ANI-0001', 'Anillo Aurora', 'unidad', 35, 5],
        ['JYL-ANI-0001', 'Anillo Aurora', 'unidad', 1, 5],
        ['JYL-ANI-0001', 'Anillo Aurora', 'unidad', 0, 5],
      ]);

      // UN artículo, no cinco, y con el total de las cinco tiendas.
      expect(r.creados).toBe(1);
      expect(await existencia('JYL-ANI-0001')).toBe(208);
    });

    test('y resubir el mismo archivo no lo duplica ni lo mueve', async () => {
      /*
       * La otra mitad, y la que de verdad protege al cliente: el archivo se resube cada
       * semana. Si el agrupado sumara sobre lo que YA está en el sistema en vez de tratarse
       * como un conteo, el stock se duplicaría en cada carga.
       */
      const r = await importar([
        ['JYL-ANI-0001', 'Anillo Aurora', 'unidad', 130, 5],
        ['JYL-ANI-0001', 'Anillo Aurora', 'unidad', 42, 5],
        ['JYL-ANI-0001', 'Anillo Aurora', 'unidad', 35, 5],
        ['JYL-ANI-0001', 'Anillo Aurora', 'unidad', 1, 5],
        ['JYL-ANI-0001', 'Anillo Aurora', 'unidad', 0, 5],
      ]);

      expect(r.sinCambio).toBe(1);
      expect(await existencia('JYL-ANI-0001')).toBe(208);
    });

    test('una fila ilegible del grupo se omite sin arrastrar a las demás', async () => {
      const r = await importar([
        ['JYL-COL-0002', 'Collar Luna', 'unidad', 10, 2],
        ['JYL-COL-0002', 'Collar Luna', 'unidad', 'no es un número', 2],
        ['JYL-COL-0002', 'Collar Luna', 'unidad', 5, 2],
      ]);

      expect(r.omitidas).toBe(1);
      expect(await existencia('JYL-COL-0002')).toBe(15);
    });
  });

  /**
   * ═════════════════════════════════════════════════════════════════════════════════════════
   * CONCESIONARIA: UN VEHÍCULO VENDIDO NO ES EXISTENCIA (2026-08-25)
   * ═════════════════════════════════════════════════════════════════════════════════════════
   *
   * Reporte de Keneth ("el inventario no estaba jalando bien") sobre el archivo real de
   * CarsGT. El detector de esquema SÍ reconocía la hoja —`Ventas[ID Vehiculo] →
   * Inventario[ID Vehiculo]`, cobertura 100 %— y el camino serializado la importaba. El
   * defecto estaba un paso después: cada fila valía 1 sin mirar el estado, así que los
   * vehículos VENDIDOS entraban como stock.
   *
   * En el archivo real, 260 filas: 240 `Vendido`, 18 `Disponible`, 2 `Reservado`. El
   * inventario decía 260 unidades donde hay 20.
   *
   * Va contra Postgres y no en unitario porque lo que hay que comprobar es el SALDO, y el
   * saldo lo calcula la base a partir de los movimientos.
   */
  describe('inventario serializado con estado (CarsGT)', () => {
    const HEADER_CARS = [
      'ID Vehiculo',
      'VIN',
      'Marca',
      'Modelo',
      'Costo Adquisicion (Q)',
      'Sucursal',
      'Estado',
    ];

    const importarCars = (rows: unknown[][]) =>
      importarInventario(db(), {
        companyId: empresa,
        documentId: docBase,
        userId: usuario,
        headerRow: HEADER_CARS,
        rows,
        baseCurrency: 'GTQ',
        // El worker resuelve el mapa por el ESQUEMA del libro, no por vocabulario.
        mapa: mapearInventarioSerializado(HEADER_CARS, 0),
      });

    test('lo vendido queda en CERO y lo disponible en uno', async () => {
      const r = await importarCars([
        ['CAR-0001', 'VIN0001', 'Toyota', 'Corolla', 99384, 'Mixco', 'Disponible'],
        ['CAR-0002', 'VIN0002', 'Nissan', 'Sentra', 121793, 'Mixco', 'Vendido'],
        ['CAR-0003', 'VIN0003', 'Kia', 'Sportage', 150000, 'Zona 10', 'Reservado'],
      ]);

      expect(r.creados).toBe(3);
      // Los tres vehículos EXISTEN como ficha: el vendido también fue real.
      expect(await existencia('CAR-0001')).toBe(1);
      expect(await existencia('CAR-0003')).toBe(1);
      // Lo que ya no es cierto es que el vendido esté en el lote.
      expect(await existencia('CAR-0002')).toBe(0);
    });

    test('el vehículo que SE VENDE entre dos cargas baja a cero, con su movimiento', async () => {
      // Estaba disponible en la carga de arriba; esta semana ya se vendió.
      const r = await importarCars([
        ['CAR-0001', 'VIN0001', 'Toyota', 'Corolla', 99384, 'Mixco', 'Vendido'],
      ]);

      expect(r.ajustados).toBe(1);
      expect(await existencia('CAR-0001')).toBe(0);

      // El saldo sigue siendo el doblez de su ledger: nadie escribió la columna a mano.
      const [suma] = await owner`
        select coalesce(sum(m.quantity), 0)::float8 as q
        from inventory_movements m
        join inventory_items i on i.id = m.item_id
        where i.company_id = ${empresa} and lower(i.sku) = 'car-0001'
      `;
      expect(suma!.q).toBe(0);
    });

    test('RESUBIR el archivo de la concesionaria no mueve nada', async () => {
      const filas: unknown[][] = [
        ['CAR-0001', 'VIN0001', 'Toyota', 'Corolla', 99384, 'Mixco', 'Vendido'],
        ['CAR-0003', 'VIN0003', 'Kia', 'Sportage', 150000, 'Zona 10', 'Reservado'],
      ];
      const r = await importarCars(filas);

      expect(r).toEqual({ creados: 0, ajustados: 0, sinCambio: 2, omitidas: 0 });
      expect(await existencia('CAR-0001')).toBe(0);
      expect(await existencia('CAR-0003')).toBe(1);
    });

    /*
     * El sesgo: solo se resta lo que se reconoce. Un estado que no entendemos cuenta como
     * existencia, porque contar de más se ve y se reporta, y contar de menos le borra
     * inventario al cliente sin que nada falle.
     */
    test('un estado desconocido cuenta como existencia', async () => {
      await importarCars([
        ['CAR-0009', 'VIN0009', 'Mazda', 'CX-5', 180000, 'Mixco', 'En tránsito aduanal'],
      ]);
      expect(await existencia('CAR-0009')).toBe(1);
    });
  });
});
