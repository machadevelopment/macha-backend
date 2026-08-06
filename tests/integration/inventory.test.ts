import { describe, expect, test, beforeAll, afterAll } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/postgres-js';
import { setupTestDatabase, ownerConnection, appConnection, rejectionCode } from './setup';
import * as schema from '@/db/schema';
import {
  InventoryError,
  createItem,
  discontinueItem,
  recordMovement,
  updateItem,
} from '@/modules/inventory/service';

/**
 * El invariante central del inventario: `quantity_on_hand` es el doblez de
 * `inventory_movements`, y no un número que se pueda escribir por otro lado.
 *
 * Se prueba contra Postgres real y no con mocks porque las dos mitades que lo sostienen
 * son de la base: el UPDATE con aritmética en SQL (para que dos salidas simultáneas no se
 * pierdan una lectura) y el privilegio que impide editar el ledger. Un mock del `db`
 * pasaría en verde con las dos rotas.
 */
describe('inventario: existencia, historial y aislamiento', () => {
  let owner: ReturnType<typeof ownerConnection>;
  let app: ReturnType<typeof appConnection>;
  let db: ReturnType<typeof drizzle<typeof schema>>;
  const empresa = randomUUID();
  const usuario = randomUUID();

  beforeAll(async () => {
    await setupTestDatabase();
    owner = ownerConnection();
    app = appConnection();
    db = drizzle(owner, { schema });
    await owner`
      insert into companies (id, workos_org_id, name, industry, base_currency, locale)
      values (${empresa}, ${'org_' + empresa}, ${'Bodega ' + empresa}, 'retail', 'GTQ', 'es')
    `;
  });

  afterAll(async () => {
    await owner?.end();
    await app?.end();
  });

  const saldo = async (id: string): Promise<number> => {
    const [fila] = await owner`select quantity_on_hand from inventory_items where id = ${id}`;
    return Number(fila!.quantity_on_hand);
  };

  test('la existencia inicial entra como movimiento de apertura, no como un número suelto', async () => {
    // Si el alta escribiera la existencia directo en la columna, habría un saldo que
    // ningún movimiento explica — y la primera pregunta seria sobre el inventario es
    // justamente "¿de dónde salió esto?".
    const { id } = await createItem(db, empresa, usuario, {
      sku: 'CAFE-500',
      name: 'Café Antigua 500g',
      quantityOnHand: 40,
      unitCost: 25,
    });

    expect(await saldo(id)).toBe(40);

    const movimientos = await owner`
      select movement_type, quantity, quantity_after, reason
      from inventory_movements where item_id = ${id}
    `;
    expect(movimientos).toHaveLength(1);
    expect(movimientos[0]!.movement_type).toBe('in');
    expect(Number(movimientos[0]!.quantity)).toBe(40);
    expect(Number(movimientos[0]!.quantity_after)).toBe(40);
  });

  test('la existencia sigue siendo la suma de los movimientos tras entradas, salidas y ajustes', async () => {
    const { id } = await createItem(db, empresa, usuario, {
      sku: 'AZUCAR-1LB',
      name: 'Azúcar 1lb',
      quantityOnHand: 100,
    });

    await recordMovement(db, empresa, usuario, { itemId: id, movementType: 'in', quantity: 50 });
    await recordMovement(db, empresa, usuario, { itemId: id, movementType: 'out', quantity: 30 });
    // Ajuste negativo: el conteo físico dice que faltan 5. No salió mercadería, se
    // corrigió el libro — por eso es `adjustment` y no `out`.
    await recordMovement(db, empresa, usuario, {
      itemId: id,
      movementType: 'adjustment',
      quantity: -5,
      reason: 'Conteo físico',
    });

    expect(await saldo(id)).toBe(115);

    // Y la comprobación que de verdad importa: el saldo guardado coincide con doblar el
    // ledger desde cero. Si algún camino escribiera la columna por su cuenta, esto se
    // separaría.
    const [fold] = await owner`
      select sum(case when movement_type = 'out' then -quantity else quantity end) as total
      from inventory_movements where item_id = ${id}
    `;
    expect(Number(fold!.total)).toBe(115);
  });

  test('cada movimiento deja registrada la existencia resultante', async () => {
    // El historial tiene que poder contarse solo: sin `quantity_after` habría que re-doblar
    // el ledger para saber cómo iba el conteo en cada punto.
    const { id } = await createItem(db, empresa, usuario, { sku: 'SAL-1LB', name: 'Sal 1lb' });
    await recordMovement(db, empresa, usuario, { itemId: id, movementType: 'in', quantity: 10 });
    await recordMovement(db, empresa, usuario, { itemId: id, movementType: 'out', quantity: 4 });

    const filas = await owner`
      select quantity_after from inventory_movements
      where item_id = ${id} order by occurred_at
    `;
    expect(filas.map((f) => Number(f.quantity_after))).toEqual([10, 6]);
  });

  test('editar el artículo NO puede cambiar la existencia', async () => {
    // Es la regla que hace que el historial sirva: si la edición pudiera mover el stock,
    // existiría un camino para cambiarlo sin dejar rastro de por qué.
    const { id } = await createItem(db, empresa, usuario, {
      sku: 'HARINA-5LB',
      name: 'Harina 5lb',
      quantityOnHand: 20,
    });

    await updateItem(db, empresa, id, {
      name: 'Harina Ideal 5lb',
      reorderPoint: 8,
      // `quantityOnHand` ni siquiera existe en el tipo de entrada; el intento se queda en
      // el compilador. Esto comprueba lo otro: que una edición legítima la deje intacta.
    });

    expect(await saldo(id)).toBe(20);
    const [fila] = await owner`select name, reorder_point from inventory_items where id = ${id}`;
    expect(fila!.name).toBe('Harina Ideal 5lb');
    expect(Number(fila!.reorder_point)).toBe(8);
  });

  test('el costo unitario se convierte a la moneda base y congela su tasa', async () => {
    // Sin esto, el valor total del inventario sumaría quetzales con dólares.
    await owner`
      insert into fx_rates (company_id, base_currency, quote_currency, rate, effective_date)
      values (${empresa}, 'GTQ', 'USD', 7.8, '2020-01-01')
    `;
    const { id } = await createItem(db, empresa, usuario, {
      sku: 'IMPORT-1',
      name: 'Producto importado',
      unitCost: 10,
      unitCostCurrency: 'USD',
    });

    const [fila] = await owner`
      select unit_cost_original, unit_cost_currency, unit_cost_base, fx_rate
      from inventory_items where id = ${id}
    `;
    expect(Number(fila!.unit_cost_original)).toBe(10);
    expect(fila!.unit_cost_currency).toBe('USD');
    expect(Number(fila!.unit_cost_base)).toBe(78);
    expect(Number(fila!.fx_rate)).toBe(7.8);
  });

  test('un costo en la moneda base no exige tener tasa de cambio cargada', async () => {
    // Exigir una fila de fx_rates para un costo en quetzales de una empresa que factura en
    // quetzales bloquearía el alta por una tasa que nadie necesita.
    const sinTasas = randomUUID();
    await owner`
      insert into companies (id, workos_org_id, name, industry, base_currency, locale)
      values (${sinTasas}, ${'org_' + sinTasas}, ${'Sin tasas'}, 'retail', 'GTQ', 'es')
    `;
    const { id } = await createItem(db, sinTasas, usuario, {
      sku: 'LOCAL-1',
      name: 'Producto local',
      unitCost: 35,
      unitCostCurrency: 'GTQ',
    });
    const [fila] =
      await owner`select unit_cost_base, fx_rate from inventory_items where id = ${id}`;
    expect(Number(fila!.unit_cost_base)).toBe(35);
    expect(Number(fila!.fx_rate)).toBe(1);
  });

  test('el SKU duplicado se rechaza con un mensaje accionable, no con un 500', async () => {
    await createItem(db, empresa, usuario, { sku: 'DUP-1', name: 'Primero' });
    const error = await createItem(db, empresa, usuario, { sku: 'dup-1', name: 'Segundo' }).catch(
      (e) => e,
    );
    expect(error).toBeInstanceOf(InventoryError);
    // Con el SKU adentro: es lo que deja que la persona lo corrija sola.
    expect((error as Error).message).toContain('dup-1');
  });

  test('dar de baja libera el SKU para volver a usarlo', async () => {
    // El índice único es parcial sobre los no borrados a propósito: un SKU descontinuado no
    // debe bloquear para siempre ese código.
    const { id } = await createItem(db, empresa, usuario, { sku: 'REUSO-1', name: 'Viejo' });
    await discontinueItem(db, empresa, id);
    const { id: nuevo } = await createItem(db, empresa, usuario, { sku: 'REUSO-1', name: 'Nuevo' });
    expect(nuevo).not.toBe(id);
  });

  test('el historial de un artículo dado de baja sobrevive a la baja', async () => {
    const { id } = await createItem(db, empresa, usuario, {
      sku: 'HIST-1',
      name: 'Con historial',
      quantityOnHand: 12,
    });
    await discontinueItem(db, empresa, id);
    const filas = await owner`select id from inventory_movements where item_id = ${id}`;
    expect(filas.length).toBeGreaterThan(0);
  });

  test('no se puede mover existencia de un artículo dado de baja', async () => {
    const { id } = await createItem(db, empresa, usuario, { sku: 'BAJA-1', name: 'Dado de baja' });
    await discontinueItem(db, empresa, id);
    const error = await recordMovement(db, empresa, usuario, {
      itemId: id,
      movementType: 'in',
      quantity: 5,
    }).catch((e) => e);
    expect(error).toBeInstanceOf(InventoryError);
  });

  test('una entrada o salida de cantidad no positiva se rechaza antes de tocar la base', async () => {
    const { id } = await createItem(db, empresa, usuario, { sku: 'CERO-1', name: 'Cero' });
    for (const caso of [
      { movementType: 'in' as const, quantity: 0 },
      { movementType: 'out' as const, quantity: -3 },
      { movementType: 'adjustment' as const, quantity: 0 },
    ]) {
      const error = await recordMovement(db, empresa, usuario, { itemId: id, ...caso }).catch(
        (e) => e,
      );
      expect(error).toBeInstanceOf(InventoryError);
    }
    expect(await saldo(id)).toBe(0);
  });

  test('el ledger de movimientos es append-only para el rol de la app', async () => {
    // La otra mitad del invariante: aunque el servicio sea el único escritor de la
    // existencia, un UPDATE al historial permitiría reescribir la explicación.
    // 42501 = insufficient_privilege.
    expect(
      await rejectionCode(app.unsafe('update inventory_movements set quantity = 1 where false')),
    ).toBe('42501');
    expect(await rejectionCode(app.unsafe('delete from inventory_movements where false'))).toBe(
      '42501',
    );
  });

  test('el inventario de otra empresa no se ve con el GUC de la mía', async () => {
    const otra = randomUUID();
    await owner`
      insert into companies (id, workos_org_id, name, industry, base_currency, locale)
      values (${otra}, ${'org_' + otra}, ${'Ajena'}, 'retail', 'GTQ', 'es')
    `;
    await createItem(db, otra, usuario, { sku: 'AJENO-1', name: 'De la otra empresa' });

    // Conectado como macha_app y con el GUC apuntando a MI empresa, el SKU de la otra no
    // debe existir. Es el backstop de RLS: el scoping principal está en los guards, pero si
    // un handler se olvidara del where, esto es lo que evita la fuga.
    await app.begin(async (tx) => {
      await tx.unsafe(`set local app.company_id = '${empresa}'`);
      const filas = await tx`select sku from inventory_items where sku = 'AJENO-1'`;
      expect(filas).toHaveLength(0);
    });
  });
});
