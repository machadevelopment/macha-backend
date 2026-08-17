import { Elysia, t } from 'elysia';
import { and, desc, eq, isNull, sql as rawSql } from 'drizzle-orm';
import { tenantDerive } from '@/guards/tenant.derive';
import { assertClientCapability } from '@/guards/require-capability';
import { enforceTokenBucket, rateLimitedResponse } from '@/lib/rate-limit';
import { companies, inventoryItems, inventoryMovements, products } from '@/db/schema';
import { InventoryError, createItem, discontinueItem, recordMovement, updateItem } from './service';
import { costosUnitariosDeducidos } from './derived-cost';

/**
 * Inventario del cliente (pantalla "Inventario" del prototipo MVP Macha).
 *
 * Leer usa `view_dashboard_reports` —lo mismo que el resto de pantallas de consulta— y
 * escribir usa `manage_inventory`, que incluye a `member` por la misma razón que
 * `upload_excel`: quien cuenta la mercadería en una pyme casi nunca es el dueño (ver la
 * nota de la matriz en `lib/permissions.ts`).
 *
 * Toda la aritmética de existencias vive en `service.ts` y no aquí. La ruta valida forma y
 * permisos; el invariante de que `quantity_on_hand` sea el doblez del ledger depende de que
 * exista UN solo escritor, y ese escritor no puede ser un handler HTTP.
 */

const MONEDA = t.Union([t.Literal('GTQ'), t.Literal('USD')]);

const ITEM_RESPONSE = t.Object({
  id: t.String(),
  sku: t.String(),
  name: t.String(),
  productId: t.Union([t.String(), t.Null()]),
  productName: t.Union([t.String(), t.Null()]),
  location: t.Union([t.String(), t.Null()]),
  quantityOnHand: t.Number(),
  reorderPoint: t.Number(),
  unitCostOriginal: t.Number(),
  unitCostCurrency: t.String(),
  unitCostBase: t.Number(),
  /**
   * CU-868kt25ev: el costo NO vino del archivo — se dedujo del costo promedio de lo que la
   * empresa ya vendió de ese producto. La pantalla lo marca en vez de presentarlo como un
   * dato del cliente. `false` cuando el archivo sí trajo costo, que es el caso normal.
   */
  unitCostIsDerived: t.Boolean(),
  /** Existencia × costo unitario en moneda base. Se calcula aquí y no en la UI para que
   *  el valor del inventario sea el mismo número en pantalla, en un reporte y en el chat. */
  stockValueBase: t.Number(),
  supplier: t.Union([t.String(), t.Null()]),
  lastRestockDate: t.Union([t.String(), t.Null()]),
  /** El SKU está en o por debajo de su punto de reorden. Se resuelve en el servidor
   *  porque es la misma comparación que va a necesitar la alerta, y duplicarla en la UI
   *  garantizaría que un día dejen de coincidir. */
  belowReorderPoint: t.Boolean(),
});

const MOVEMENT_RESPONSE = t.Object({
  id: t.String(),
  itemId: t.String(),
  itemName: t.String(),
  movementType: t.Union([t.Literal('in'), t.Literal('out'), t.Literal('adjustment')]),
  quantity: t.Number(),
  quantityAfter: t.Number(),
  reason: t.Union([t.String(), t.Null()]),
  occurredAt: t.String(),
});

/** Traduce un error de negocio a 400 accionable; cualquier otro sigue su curso a 500. */
function asBadRequest(error: unknown, set: { status?: number | string }): { error: string } {
  if (error instanceof InventoryError) {
    set.status = 400;
    return { error: error.message };
  }
  throw error;
}

export const inventory = new Elysia({ prefix: '/inventory' })
  .use(tenantDerive)
  .get(
    '/',
    async ({ companyId, role, set, db }) => {
      assertClientCapability(role, 'view_dashboard_reports', set);

      const limited = await enforceTokenBucket('read', companyId, set, 'GET /inventory');
      if (limited) return limited;

      const [company] = await db
        .select({ baseCurrency: companies.baseCurrency })
        .from(companies)
        .where(eq(companies.id, companyId));

      // LEFT JOIN: el enlace al catálogo de productos es opcional (hay SKUs en bodega que
      // todavía no se le han vendido a nadie), así que un INNER JOIN escondería justo los
      // artículos recién dados de alta.
      const filas = await db
        .select({
          id: inventoryItems.id,
          sku: inventoryItems.sku,
          name: inventoryItems.name,
          productId: inventoryItems.productId,
          productName: products.name,
          location: inventoryItems.location,
          quantityOnHand: inventoryItems.quantityOnHand,
          reorderPoint: inventoryItems.reorderPoint,
          unitCostOriginal: inventoryItems.unitCostOriginal,
          unitCostCurrency: inventoryItems.unitCostCurrency,
          unitCostBase: inventoryItems.unitCostBase,
          supplier: inventoryItems.supplier,
          lastRestockDate: inventoryItems.lastRestockDate,
        })
        .from(inventoryItems)
        .leftJoin(
          products,
          and(
            eq(products.id, inventoryItems.productId),
            eq(products.companyId, inventoryItems.companyId),
          ),
        )
        .where(and(eq(inventoryItems.companyId, companyId), isNull(inventoryItems.deletedAt)))
        .orderBy(inventoryItems.name);

      /*
       * CU-868kt25ev: el costo se DEDUCE para los SKU cuyo archivo no lo trajo.
       *
       * Se pide una sola vez por petición y solo si de verdad hace falta — si ningún item
       * está en cero (el caso de las empresas cuya plantilla sí trae costo), no se consulta
       * `transactions` en absoluto. Ver `derived-cost.ts` para el porqué de deducirlo al
       * LEER y no al importar.
       */
      const faltaCosto = filas.some((f) => Number(f.unitCostBase) === 0);
      const deducidos = faltaCosto
        ? await costosUnitariosDeducidos(db, companyId)
        : new Map<string, number>();

      const items = filas.map((f) => {
        const cantidad = Number(f.quantityOnHand);
        const delArchivo = Number(f.unitCostBase);
        const reorden = Number(f.reorderPoint);

        // El costo del archivo MANDA siempre, aunque difiera del promedio: es el dato del
        // cliente. La deducción solo llena el hueco.
        const deducido = delArchivo === 0 && f.productId ? deducidos.get(f.productId) : undefined;
        const costoBase = deducido ?? delArchivo;

        return {
          id: f.id,
          sku: f.sku,
          name: f.name,
          productId: f.productId,
          productName: f.productName,
          location: f.location,
          quantityOnHand: cantidad,
          reorderPoint: reorden,
          unitCostOriginal: Number(f.unitCostOriginal),
          unitCostCurrency: f.unitCostCurrency,
          unitCostBase: costoBase,
          // La pantalla puede decir de dónde salió la cifra en vez de presentar una
          // deducción nuestra como si viniera del archivo del cliente.
          unitCostIsDerived: deducido !== undefined,
          stockValueBase: cantidad * costoBase,
          supplier: f.supplier,
          lastRestockDate: f.lastRestockDate,
          // `> 0` en el punto de reorden: un SKU con reorden 0 es uno al que nadie le puso
          // umbral, y marcarlo en rojo apenas se agota llenaría la pantalla de avisos que
          // nadie configuró.
          belowReorderPoint: reorden > 0 && cantidad <= reorden,
        };
      });

      return {
        baseCurrency: company?.baseCurrency ?? 'GTQ',
        items,
        // Los totales salen del servidor por la misma razón que `stockValueBase`: si la UI
        // los sumara, una tabla paginada mañana daría un total distinto al real.
        totalStockValueBase: items.reduce((s, i) => s + i.stockValueBase, 0),
        belowReorderCount: items.filter((i) => i.belowReorderPoint).length,
      };
    },
    {
      response: {
        200: t.Object({
          baseCurrency: t.String(),
          items: t.Array(ITEM_RESPONSE),
          totalStockValueBase: t.Number(),
          belowReorderCount: t.Number(),
        }),
        429: rateLimitedResponse,
      },
    },
  )
  .get(
    '/movements',
    async ({ companyId, role, query, set, db }) => {
      assertClientCapability(role, 'view_dashboard_reports', set);

      const limited = await enforceTokenBucket('read', companyId, set, 'GET /inventory/movements');
      if (limited) return limited;

      const filtroItem = query.itemId ? eq(inventoryMovements.itemId, query.itemId) : rawSql`true`;

      const filas = await db
        .select({
          id: inventoryMovements.id,
          itemId: inventoryMovements.itemId,
          itemName: inventoryItems.name,
          movementType: inventoryMovements.movementType,
          quantity: inventoryMovements.quantity,
          quantityAfter: inventoryMovements.quantityAfter,
          reason: inventoryMovements.reason,
          occurredAt: inventoryMovements.occurredAt,
        })
        .from(inventoryMovements)
        .innerJoin(
          inventoryItems,
          and(
            eq(inventoryItems.id, inventoryMovements.itemId),
            eq(inventoryItems.companyId, inventoryMovements.companyId),
          ),
        )
        .where(and(eq(inventoryMovements.companyId, companyId), filtroItem))
        .orderBy(desc(inventoryMovements.occurredAt))
        .limit(query.limit ?? 100);

      return {
        movements: filas.map((f) => ({
          id: f.id,
          itemId: f.itemId,
          itemName: f.itemName,
          movementType: f.movementType,
          quantity: Number(f.quantity),
          quantityAfter: Number(f.quantityAfter),
          reason: f.reason,
          occurredAt: f.occurredAt.toISOString(),
        })),
      };
    },
    {
      query: t.Object({
        itemId: t.Optional(t.String({ format: 'uuid' })),
        limit: t.Optional(t.Numeric({ minimum: 1, maximum: 500 })),
      }),
      response: {
        200: t.Object({ movements: t.Array(MOVEMENT_RESPONSE) }),
        429: rateLimitedResponse,
      },
    },
  )
  .post(
    '/',
    async ({ companyId, userId, role, body, set, db }) => {
      assertClientCapability(role, 'manage_inventory', set);

      const limited = await enforceTokenBucket('write', companyId, set, 'POST /inventory');
      if (limited) return limited;

      try {
        const { id } = await createItem(db, companyId, userId, body);
        set.status = 201;
        return { id };
      } catch (error) {
        return asBadRequest(error, set);
      }
    },
    {
      body: t.Object({
        sku: t.String({ minLength: 1, maxLength: 64 }),
        name: t.String({ minLength: 1, maxLength: 200 }),
        productId: t.Optional(t.Union([t.String({ format: 'uuid' }), t.Null()])),
        location: t.Optional(t.Union([t.String({ maxLength: 120 }), t.Null()])),
        quantityOnHand: t.Optional(t.Number({ minimum: 0 })),
        reorderPoint: t.Optional(t.Number({ minimum: 0 })),
        unitCost: t.Optional(t.Number({ minimum: 0 })),
        unitCostCurrency: t.Optional(MONEDA),
        supplier: t.Optional(t.Union([t.String({ maxLength: 200 }), t.Null()])),
      }),
      response: {
        201: t.Object({ id: t.String() }),
        400: t.Object({ error: t.String() }),
        429: rateLimitedResponse,
      },
    },
  )
  .patch(
    '/:id',
    async ({ companyId, role, params, body, set, db }) => {
      assertClientCapability(role, 'manage_inventory', set);

      const limited = await enforceTokenBucket('write', companyId, set, 'PATCH /inventory/:id');
      if (limited) return limited;

      try {
        await updateItem(db, companyId, params.id, body);
        return { ok: true as const };
      } catch (error) {
        return asBadRequest(error, set);
      }
    },
    {
      params: t.Object({ id: t.String({ format: 'uuid' }) }),
      // Sin `quantityOnHand` a propósito: la existencia se cambia registrando un
      // movimiento, no editando el número. Ver la nota de `updateItem`.
      body: t.Object({
        name: t.Optional(t.String({ minLength: 1, maxLength: 200 })),
        productId: t.Optional(t.Union([t.String({ format: 'uuid' }), t.Null()])),
        location: t.Optional(t.Union([t.String({ maxLength: 120 }), t.Null()])),
        reorderPoint: t.Optional(t.Number({ minimum: 0 })),
        unitCost: t.Optional(t.Number({ minimum: 0 })),
        unitCostCurrency: t.Optional(MONEDA),
        supplier: t.Optional(t.Union([t.String({ maxLength: 200 }), t.Null()])),
      }),
      response: {
        200: t.Object({ ok: t.Literal(true) }),
        400: t.Object({ error: t.String() }),
        429: rateLimitedResponse,
      },
    },
  )
  .post(
    '/:id/movements',
    async ({ companyId, userId, role, params, body, set, db }) => {
      assertClientCapability(role, 'manage_inventory', set);

      const limited = await enforceTokenBucket(
        'write',
        companyId,
        set,
        'POST /inventory/:id/movements',
      );
      if (limited) return limited;

      try {
        const resultado = await recordMovement(db, companyId, userId, {
          itemId: params.id,
          movementType: body.movementType,
          quantity: body.quantity,
          reason: body.reason,
        });
        set.status = 201;
        return resultado;
      } catch (error) {
        return asBadRequest(error, set);
      }
    },
    {
      params: t.Object({ id: t.String({ format: 'uuid' }) }),
      body: t.Object({
        movementType: t.Union([t.Literal('in'), t.Literal('out'), t.Literal('adjustment')]),
        quantity: t.Number(),
        reason: t.Optional(t.Union([t.String({ maxLength: 300 }), t.Null()])),
      }),
      response: {
        201: t.Object({ id: t.String(), quantityAfter: t.Number() }),
        400: t.Object({ error: t.String() }),
        429: rateLimitedResponse,
      },
    },
  )
  .delete(
    '/:id',
    async ({ companyId, role, params, set, db }) => {
      assertClientCapability(role, 'manage_inventory', set);

      const limited = await enforceTokenBucket('write', companyId, set, 'DELETE /inventory/:id');
      if (limited) return limited;

      try {
        await discontinueItem(db, companyId, params.id);
        return { ok: true as const };
      } catch (error) {
        return asBadRequest(error, set);
      }
    },
    {
      params: t.Object({ id: t.String({ format: 'uuid' }) }),
      response: {
        200: t.Object({ ok: t.Literal(true) }),
        400: t.Object({ error: t.String() }),
        429: rateLimitedResponse,
      },
    },
  );
