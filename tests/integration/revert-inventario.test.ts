import { describe, expect, test, beforeAll, afterAll } from 'bun:test';
import { setupTestDatabase, ownerConnection, testOwnerUrl, testAppUrl } from './setup';

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * REVERTIR UNA CARGA TIENE QUE LLEVARSE LOS ARTÍCULOS QUE ESA CARGA CREÓ
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *
 * Reporte de Keneth (2026-08-30): *"he subido 4 archivos, les di revert y toda la data del
 * dashboard se limpia pero el inventario sigue apareciendo lo del primer excel que subí"*.
 *
 * El síntoma señala exactamente la causa, y es más específico de lo que parece: sigue
 * apareciendo lo del PRIMERO porque el importador trata la cantidad como un CONTEO —el primer
 * archivo CREA el artículo con su nombre, SKU y costo, y los siguientes solo ajustan la
 * cantidad del mismo SKU—. Así que los artículos que se ven en pantalla son, por construcción,
 * los que creó la primera carga.
 *
 * `compensarInventario` hace bien su trabajo: deja la existencia en cero. Pero el listado
 * filtra por `deleted_at` y **nunca por cantidad**, así que el artículo sigue ahí: con su
 * nombre, su SKU y su costo, en cero. Para el dueño eso no es "vacío", es su inventario
 * mostrando cosas que ya revirtió — y lo compara contra un dashboard que sí quedó limpio.
 *
 * Este test lo reproduce con las CUATRO cargas del reporte, contra Postgres real.
 */

process.env.DATABASE_URL = testOwnerUrl;
process.env.APP_DATABASE_URL = testAppUrl;

const { createItem, recordMovement } = await import('@/modules/inventory/service');
const { revertDocument } = await import('@/lib/promotion');
const { withCompanyScope } = await import('@/lib/db-scope');

const owner = ownerConnection();
let companyId: string;
let userId: string;
const docs: string[] = [];
/** Segunda empresa, para los casos que NO deben borrar el artículo. */
let coB: string;
let uB: string;
const docsB: string[] = [];

/** Las cuatro cargas del reporte: la primera crea el SKU, las demás lo ajustan. */
const CONTEOS = [100, 150, 120, 200];

beforeAll(async () => {
  await setupTestDatabase();
  const [c] = await owner`
    insert into companies (workos_org_id, name, industry, base_currency)
    values ('wos_revinv', 'Revert Inventario SA', 'retail', 'GTQ') returning id
  `;
  companyId = c!.id;
  const [u] = await owner`
    insert into users (workos_user_id, email)
    values ('wos_revinv_u', 'revinv@test.local') returning id
  `;
  userId = u!.id;

  for (let i = 0; i < CONTEOS.length; i++) {
    const [d] = await owner`
      insert into documents (company_id, uploaded_by, s3_key, original_filename,
                             file_size_bytes, mime_type, status)
      values (${companyId}, ${userId}, ${`${companyId}/inv${i}.xlsx`}, ${`inv${i}.xlsx`},
              100, 'text/csv', 'promoted')
      returning id
    `;
    docs.push(d!.id);
  }

  // Carga 1: crea el artículo. Cargas 2-4: ajustan el MISMO SKU, que es lo que hace el
  // importador real (`inventory-import.ts`: SKU conocido → ajuste por la diferencia).
  await withCompanyScope(companyId, async (db) => {
    await createItem(db, companyId, userId, {
      documentId: docs[0]!,
      sku: 'SKU-CAFE-1KG',
      name: 'Café en grano 1 kg',
      quantityOnHand: CONTEOS[0],
      unitCost: 79,
      unitCostCurrency: 'GTQ',
    });
  });

  const [it] = await owner`
    select id from inventory_items where company_id = ${companyId} and sku = 'SKU-CAFE-1KG'
  `;
  for (let i = 1; i < CONTEOS.length; i++) {
    const delta = CONTEOS[i]! - CONTEOS[i - 1]!;
    await withCompanyScope(companyId, async (db) => {
      await recordMovement(db, companyId, userId, {
        itemId: it!.id,
        movementType: delta >= 0 ? 'in' : 'out',
        quantity: Math.abs(delta),
        reason: `Conteo importado del archivo (${CONTEOS[i - 1]} → ${CONTEOS[i]})`,
        documentId: docs[i]!,
      });
    });
  }
});

afterAll(async () => {
  await owner?.end();
});

/** Empresa aparte: los casos donde el artículo TIENE que sobrevivir. */
async function montarB(): Promise<{ itemId: string }> {
  const [c] = await owner`
    insert into companies (workos_org_id, name, industry, base_currency)
    values ('wos_revinv_b', 'Revert Inventario B', 'retail', 'GTQ') returning id
  `;
  coB = c!.id;
  const [u] = await owner`
    insert into users (workos_user_id, email)
    values ('wos_revinv_b_u', 'revinvb@test.local') returning id
  `;
  uB = u!.id;
  for (let i = 0; i < 2; i++) {
    const [d] = await owner`
      insert into documents (company_id, uploaded_by, s3_key, original_filename,
                             file_size_bytes, mime_type, status)
      values (${coB}, ${uB}, ${`${coB}/b${i}.xlsx`}, ${`b${i}.xlsx`}, 100, 'text/csv', 'promoted')
      returning id
    `;
    docsB.push(d!.id);
  }
  await withCompanyScope(coB, async (db) => {
    await createItem(db, coB, uB, {
      documentId: docsB[0]!,
      sku: 'SKU-B',
      name: 'Artículo B',
      quantityOnHand: 50,
      unitCost: 10,
      unitCostCurrency: 'GTQ',
    });
  });
  const [it] = await owner`select id from inventory_items where company_id = ${coB}`;
  return { itemId: it!.id };
}

const unNumero = async (q: Promise<Record<string, unknown>[]>): Promise<number> =>
  Number((await q)[0]!.n);

describe('las cuatro cargas dejan el inventario en su último conteo', () => {
  test('antes de revertir, la existencia es la del ÚLTIMO archivo', async () => {
    // Guardia del test: si esto falla, el escenario no reproduce el del reporte.
    expect(
      await unNumero(
        owner`select quantity_on_hand as n from inventory_items
              where company_id = ${companyId} and sku = 'SKU-CAFE-1KG'`,
      ),
    ).toBe(CONTEOS[CONTEOS.length - 1]!);
  });
});

describe('al revertir las cuatro cargas', () => {
  test('la existencia queda en cero: la compensación SÍ funciona', async () => {
    for (const d of docs) {
      await withCompanyScope(companyId, (db) => revertDocument(db, companyId, d));
    }
    expect(
      await unNumero(
        owner`select quantity_on_hand as n from inventory_items
              where company_id = ${companyId} and sku = 'SKU-CAFE-1KG'`,
      ),
    ).toBe(0);
  });

  test('EL ARTÍCULO YA NO APARECE EN EL INVENTARIO', async () => {
    /*
     * El bug del reporte. El listado filtra por `deleted_at` y nunca por cantidad, así que el
     * artículo seguía ahí —con el nombre, el SKU y el costo que le puso la PRIMERA carga— en
     * cero. Para el dueño eso no es un inventario vacío: es su inventario mostrando cosas que
     * ya revirtió, mientras el dashboard sí quedó limpio.
     */
    expect(
      await unNumero(
        owner`select count(*)::int as n from inventory_items
              where company_id = ${companyId} and deleted_at is null`,
      ),
    ).toBe(0);
  });
});

describe('lo que el arreglo NO debe romper', () => {
  test('un conteo MANUAL salva al artículo, aunque la carga se revierta', async () => {
    /*
     * El criterio no es "la creó esta carga" sino "no queda nadie más sosteniéndola". Un
     * artículo que una carga creó y que alguien ajustó a mano después NO puede desaparecer
     * porque se revierta esa carga: ese conteo es trabajo de una persona, y borrarlo sería
     * peor que el bug original.
     *
     * Un movimiento manual tiene `document_id` NULL, y su sola presencia basta.
     */
    const { itemId } = await montarB();
    /*
     * Los dos movimientos manuales se compensan entre sí (neto 0) A PROPÓSITO: así, al
     * revertir la carga, la existencia queda EXACTAMENTE en cero y la única cosa que puede
     * salvar al artículo es el origen de sus movimientos.
     *
     * Sin ese cuidado el test pasaba por el motivo equivocado —la existencia quedaba en -50 y
     * la condición de cero lo rechazaba antes de mirar el origen—, y la mutación que ignora el
     * movimiento manual no lo tumbaba. Un test que pasa por la razón equivocada es peor que no
     * tenerlo: dice que una garantía está cubierta cuando no lo está.
     */
    await withCompanyScope(coB, async (db) => {
      await recordMovement(db, coB, uB, {
        itemId,
        movementType: 'out',
        quantity: 20,
        reason: 'Conteo físico de bodega',
        documentId: null,
      });
      await recordMovement(db, coB, uB, {
        itemId,
        movementType: 'in',
        quantity: 20,
        reason: 'Corrección del conteo físico',
        documentId: null,
      });
    });
    await withCompanyScope(coB, (db) => revertDocument(db, coB, docsB[0]!));

    // La existencia SÍ quedó en cero: lo que salva al artículo es el origen, no el saldo.
    expect(
      await unNumero(owner`select quantity_on_hand as n from inventory_items where id = ${itemId}`),
    ).toBe(0);

    expect(
      await unNumero(
        owner`select count(*)::int as n from inventory_items
              where company_id = ${coB} and deleted_at is null`,
      ),
    ).toBe(1);
  });

  test('revertir UNA de dos cargas no borra el artículo que la otra sostiene', async () => {
    // La segunda carga sigue viva, así que el artículo tiene quién lo sostenga.
    const [c] = await owner`
      insert into companies (workos_org_id, name, industry, base_currency)
      values ('wos_revinv_c', 'Revert Inventario C', 'retail', 'GTQ') returning id
    `;
    const co = c!.id;
    const [u] = await owner`
      insert into users (workos_user_id, email)
      values ('wos_revinv_c_u', 'revinvc@test.local') returning id
    `;
    const docsC: string[] = [];
    for (let i = 0; i < 2; i++) {
      const [d] = await owner`
        insert into documents (company_id, uploaded_by, s3_key, original_filename,
                               file_size_bytes, mime_type, status)
        values (${co}, ${u!.id}, ${`${co}/c${i}.xlsx`}, ${`c${i}.xlsx`}, 100, 'text/csv', 'promoted')
        returning id
      `;
      docsC.push(d!.id);
    }
    await withCompanyScope(co, async (db) => {
      await createItem(db, co, u!.id, {
        documentId: docsC[0]!,
        sku: 'SKU-C',
        name: 'Artículo C',
        quantityOnHand: 30,
        unitCost: 10,
        unitCostCurrency: 'GTQ',
      });
    });
    const [it] = await owner`select id from inventory_items where company_id = ${co}`;
    /*
     * Los dos movimientos de la SEGUNDA carga se compensan entre sí, por el mismo motivo que
     * en el test de arriba: así, al revertir la primera, la existencia queda exactamente en
     * cero y lo único que puede salvar al artículo es que la segunda carga siga viva.
     */
    await withCompanyScope(co, async (db) => {
      await recordMovement(db, co, u!.id, {
        itemId: it!.id,
        movementType: 'out',
        quantity: 30,
        reason: 'Conteo importado del archivo (30 → 0)',
        documentId: docsC[1]!,
      });
      await recordMovement(db, co, u!.id, {
        itemId: it!.id,
        movementType: 'in',
        quantity: 30,
        reason: 'Conteo importado del archivo (0 → 30)',
        documentId: docsC[1]!,
      });
    });
    // Se revierte SOLO la primera: la segunda sigue viva y sostiene el artículo.
    await withCompanyScope(co, (db) => revertDocument(db, co, docsC[0]!));

    expect(
      await unNumero(owner`select quantity_on_hand as n from inventory_items where id = ${it!.id}`),
    ).toBe(0);

    expect(
      await unNumero(
        owner`select count(*)::int as n from inventory_items
              where company_id = ${co} and deleted_at is null`,
      ),
    ).toBe(1);
  });

  test('revertir es idempotente: hacerlo dos veces no rompe nada', async () => {
    for (const d of docs) {
      await withCompanyScope(companyId, (db) => revertDocument(db, companyId, d));
    }
    expect(
      await unNumero(
        owner`select count(*)::int as n from inventory_items
              where company_id = ${companyId} and deleted_at is null`,
      ),
    ).toBe(0);
  });
});

describe('el artículo que nació en CERO también se va', () => {
  /*
   * ═══ LA SEGUNDA CAUSA, LA QUE DEJABA 240 VEHÍCULOS FUERA DE ALCANCE ═══
   *
   * `createItem` registra el movimiento de apertura solo si la existencia inicial es > 0, y
   * hace bien: `recordMovement` rechaza una cantidad de cero porque un movimiento de cero no
   * movió nada. Pero entonces un artículo importado con existencia 0 no tiene NI UN movimiento,
   * y `document_id` solo vivía en `inventory_movements` — así que no quedaba rastro de qué
   * carga lo creó.
   *
   * El resultado era un artículo invisible para las dos defensas a la vez: el revert no lo
   * alcanzaba (no hay movimiento que compensar) y el script de limpieza lo PROTEGÍA, porque
   * "sin movimientos" es justo su señal de que lo dio de alta una persona.
   *
   * Medido en producción: 240 vehículos así en una sola empresa.
   */
  test('una carga que crea un artículo en cero se lo lleva al revertirse', async () => {
    const [c] = await owner`
      insert into companies (workos_org_id, name, industry, base_currency)
      values ('wos_revinv_d', 'Revert Inventario D', 'retail', 'GTQ') returning id
    `;
    const co = c!.id;
    const [u] = await owner`
      insert into users (workos_user_id, email)
      values ('wos_revinv_d_u', 'revinvd@test.local') returning id
    `;
    const [d] = await owner`
      insert into documents (company_id, uploaded_by, s3_key, original_filename,
                             file_size_bytes, mime_type, status)
      values (${co}, ${u!.id}, ${`${co}/d.xlsx`}, 'd.xlsx', 100, 'text/csv', 'promoted')
      returning id
    `;

    await withCompanyScope(co, async (db) => {
      await createItem(db, co, u!.id, {
        documentId: d!.id,
        sku: 'SKU-NACE-EN-CERO',
        name: 'Vehículo en patio',
        quantityOnHand: 0,
        unitCost: 150_000,
        unitCostCurrency: 'GTQ',
      });
    });

    // Guardia: sin movimientos es exactamente lo que lo hacía invisible.
    expect(
      await unNumero(
        owner`select count(*)::int as n from inventory_movements
              where company_id = ${co}`,
      ),
    ).toBe(0);

    await withCompanyScope(co, (db) => revertDocument(db, co, d!.id));

    expect(
      await unNumero(
        owner`select count(*)::int as n from inventory_items
              where company_id = ${co} and deleted_at is null`,
      ),
    ).toBe(0);
  });

  test('un artículo en cero creado A MANO no se toca', async () => {
    // `document_id` NULL es la señal de que lo dio de alta una persona. Sigue siendo el caso
    // original y el que la columna nueva no puede pisar.
    const [c] = await owner`
      insert into companies (workos_org_id, name, industry, base_currency)
      values ('wos_revinv_e', 'Revert Inventario E', 'retail', 'GTQ') returning id
    `;
    const co = c!.id;
    const [u] = await owner`
      insert into users (workos_user_id, email)
      values ('wos_revinv_e_u', 'revinve@test.local') returning id
    `;
    const [d] = await owner`
      insert into documents (company_id, uploaded_by, s3_key, original_filename,
                             file_size_bytes, mime_type, status)
      values (${co}, ${u!.id}, ${`${co}/e.xlsx`}, 'e.xlsx', 100, 'text/csv', 'promoted')
      returning id
    `;
    await withCompanyScope(co, async (db) => {
      await createItem(db, co, u!.id, {
        sku: 'SKU-A-MANO',
        name: 'Dado de alta por una persona',
        quantityOnHand: 0,
        unitCost: 10,
        unitCostCurrency: 'GTQ',
      });
    });
    await withCompanyScope(co, (db) => revertDocument(db, co, d!.id));

    expect(
      await unNumero(
        owner`select count(*)::int as n from inventory_items
              where company_id = ${co} and deleted_at is null`,
      ),
    ).toBe(1);
  });
});
