import { describe, expect, test, beforeAll, afterAll } from 'bun:test';
import { setupTestDatabase, ownerConnection, testOwnerUrl, testAppUrl } from './setup';

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA LIMPIEZA RETROACTIVA USA EL MISMO CRITERIO QUE EL REVERT
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *
 * `scripts/limpiar-inventario-huerfano.ts` da de baja lo que quedó colgado de reverts
 * ANTERIORES al arreglo — los 264 artículos que Keneth veía en su pantalla de inventario.
 *
 * Se prueba contra Postgres real y no a ojo porque un script de limpieza que se equivoca borra
 * la contabilidad de un cliente, y porque su valor entero depende de que use **exactamente** la
 * misma condición que `compensarInventario`: si borrara con una regla distinta, dejaría el
 * inventario en un estado que el producto no sabe producir por sí solo.
 *
 * Los cuatro casos son los cuatro que importan, y tres de ellos son "NO se toca".
 */

process.env.DATABASE_URL = testOwnerUrl;
process.env.APP_DATABASE_URL = testAppUrl;

const owner = ownerConnection();
let companyId: string;
let userId: string;

const huerfanosDeLaEmpresa = () => owner.unsafe(HUERFANOS, [companyId]);

/**
 * La misma condición del script, acotada a ESTA empresa: sin el filtro, un residuo de otra
 * corrida haría que el test afirmara sobre artículos que no creó.
 */
const HUERFANOS = `
  select i.id, i.sku
    from inventory_items i
   where i.company_id = $1
     and i.deleted_at is null
     and i.quantity_on_hand = 0
     and not exists (
       select 1 from inventory_movements m
        where m.company_id = i.company_id and m.item_id = i.id
          and (m.document_id is null
               or not exists (select 1 from documents d
                               where d.id = m.document_id
                                 and d.status in ('reverted', 'cancelled')))
     )
     and exists (select 1 from inventory_movements m
                  where m.company_id = i.company_id and m.item_id = i.id)
   order by i.sku
`;

async function nuevoDoc(estado: string): Promise<string> {
  const [d] = await owner`
    insert into documents (company_id, uploaded_by, s3_key, original_filename,
                           file_size_bytes, mime_type, status)
    values (${companyId}, ${userId}, ${`${companyId}/${Math.random()}.xlsx`}, 'x.xlsx',
            100, 'text/csv', ${estado})
    returning id
  `;
  return d!.id;
}

async function nuevoItem(sku: string, cantidad: number): Promise<string> {
  const [i] = await owner`
    insert into inventory_items (company_id, sku, name, quantity_on_hand, reorder_point,
                                 unit_cost_original, unit_cost_currency, unit_cost_base,
                                 fx_rate, fx_rate_date)
    values (${companyId}, ${sku}, ${`Artículo ${sku}`}, ${String(cantidad)}, '0',
            '100', 'GTQ', '100', '1', '2026-01-01')
    returning id
  `;
  return i!.id;
}

async function mover(itemId: string, docId: string | null, cantidad: number): Promise<void> {
  await owner`
    insert into inventory_movements (company_id, item_id, movement_type, quantity,
                                     quantity_after, document_id)
    values (${companyId}, ${itemId}, 'in', ${String(cantidad)}, '0', ${docId})
  `;
}

beforeAll(async () => {
  await setupTestDatabase();
  /*
   * Identificadores únicos por corrida. El runner de integración resetea el esquema, pero
   * correr ESTE archivo suelto (que es lo que uno hace mientras lo escribe) deja datos, y la
   * siguiente corrida moría en el `beforeAll` con una violación de UNIQUE — un fallo en el
   * hook, no en una aserción, que no dice nada sobre lo que el test prueba.
   */
  const sufijo = Math.random().toString(36).slice(2, 10);
  const [c] = await owner`
    insert into companies (workos_org_id, name, industry, base_currency)
    values (${`wos_limpieza_${sufijo}`}, ${`Limpieza Inventario ${sufijo}`}, 'retail', 'GTQ') returning id
  `;
  companyId = c!.id;
  const [u] = await owner`
    insert into users (workos_user_id, email)
    values (${`wos_limpieza_u_${sufijo}`}, ${`limpieza-${sufijo}@test.local`}) returning id
  `;
  userId = u!.id;

  const revertido = await nuevoDoc('reverted');
  const vivo = await nuevoDoc('promoted');

  // (1) HUÉRFANO: en cero, su única historia es una carga revertida. Es el caso de Keneth.
  await mover(await nuevoItem('SKU-HUERFANO', 0), revertido, 5);
  // (2) Tiene un conteo MANUAL: sobrevive aunque esté en cero.
  await mover(await nuevoItem('SKU-MANUAL', 0), null, 5);
  // (3) Lo sostiene una carga VIVA: sobrevive.
  await mover(await nuevoItem('SKU-VIVO', 0), vivo, 5);
  // (4) En cero pero CON existencia... no: con stock. Sobrevive por la condición de cantidad.
  await mover(await nuevoItem('SKU-CON-STOCK', 12), revertido, 12);
  // (5) SIN un solo movimiento: lo creó una persona a mano. No se toca.
  await nuevoItem('SKU-SIN-MOVIMIENTOS', 0);
});

afterAll(async () => {
  await owner?.end();
});

describe('el script solo se lleva lo que ya no sostiene nadie', () => {
  test('identifica exactamente UN huérfano de los cinco artículos', async () => {
    const filas = await huerfanosDeLaEmpresa();
    expect(filas.map((f) => f.sku)).toEqual(['SKU-HUERFANO']);
  });

  test('un conteo MANUAL salva al artículo', async () => {
    /*
     * ⚠️ Este caso lo garantiza el `not exists` sobre `documents`, NO la cláusula
     * `m.document_id is null` que está escrita al lado: un `document_id` NULL nunca casa
     * contra `documents`, así que esa cláusula es redundante en esta consulta y quitarla no
     * cambia ni un resultado (comprobado por mutación).
     *
     * Se deja anotado porque lo contrario —creer que este test protege esa línea— es
     * exactamente el tipo de falsa cobertura que ya me costó dos tests hoy. En
     * `compensarInventario` la misma cláusula SÍ es necesaria, porque allá hay un `<>` de por
     * medio; allá la mutación sí tumba tests.
     */
    const filas = await huerfanosDeLaEmpresa();
    expect(filas.map((f) => f.sku)).not.toContain('SKU-MANUAL');
  });

  test('una carga VIVA salva al artículo', async () => {
    const filas = await huerfanosDeLaEmpresa();
    expect(filas.map((f) => f.sku)).not.toContain('SKU-VIVO');
  });

  test('un artículo CON stock nunca se toca, venga de donde venga', async () => {
    // Un artículo con existencia es un dato del cliente, sin importar qué carga lo puso ahí.
    const filas = await huerfanosDeLaEmpresa();
    expect(filas.map((f) => f.sku)).not.toContain('SKU-CON-STOCK');
  });

  test('un artículo SIN movimientos no se toca: lo creó una persona', async () => {
    /*
     * Sin movimientos no hay carga que lo haya originado, así que lo dio de alta alguien a
     * mano y su existencia en cero es un dato, no basura. Es el caso que el `exists` final
     * del script protege, y es fácil de perder al escribir la consulta.
     */
    const filas = await huerfanosDeLaEmpresa();
    expect(filas.map((f) => f.sku)).not.toContain('SKU-SIN-MOVIMIENTOS');
  });
});
