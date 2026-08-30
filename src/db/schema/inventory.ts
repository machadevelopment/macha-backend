import {
  pgTable,
  uuid,
  text,
  numeric,
  date,
  timestamp,
  uniqueIndex,
  index,
  foreignKey,
} from 'drizzle-orm/pg-core';
import { companies } from './companies';
import { products } from './dimensions';

/**
 * Inventario (pantalla "Inventario" del prototipo MVP Macha).
 *
 * **Por qué NO son tablas particionadas.** `transactions`/`invoices`/`bills` se
 * particionan por `company_id` porque son el volumen del producto: crecen con cada fila
 * de cada Excel, para siempre. El inventario de una PYME es un catálogo de existencias —
 * cientos de SKUs, no millones de filas — y se parece mucho más a `products`/`stores`,
 * que son tablas planas con RLS. Particionar esto solo agregaría el costo de crear dos
 * particiones más en cada aprovisionamiento de empresa a cambio de nada.
 *
 * **Dos tablas y no una.** El stock actual es un dato de UNA fila por SKU que se lee en
 * cada pantalla; el historial de movimientos es un ledger que solo crece. Meterlos en la
 * misma tabla obliga a elegir entre las dos formas de acceso.
 */

// Existencias por SKU. Es el estado actual; el "por qué" está en inventory_movements.
export const inventoryItems = pgTable(
  'inventory_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id),
    /**
     * Enlace opcional al catálogo de productos. Opcional porque las dos entidades entran
     * al sistema por puertas distintas: los productos los descubre la ingesta leyendo
     * ventas, y los items de inventario los da de alta una persona. Se puede tener un
     * producto que se vende y nunca se inventarió (un servicio), y un SKU en bodega que
     * todavía no se le ha vendido a nadie. Exigir el enlace obligaría a inventar la mitad
     * que falta.
     */
    productId: uuid('product_id'),
    /**
     * Carga de Excel que dio de alta este artículo. NULL = lo creó una persona a mano.
     *
     * Vive acá y no solo en `inventory_movements` porque un artículo importado con existencia
     * CERO no tiene ni un movimiento (`recordMovement` rechaza cantidad 0, con razón), así que
     * sin esta columna no había forma de saber de qué carga salió — y el revert no lo
     * alcanzaba. Ver la migración 0038 para los 240 vehículos que lo destaparon.
     */
    documentId: uuid('document_id'),
    sku: text('sku').notNull(),
    name: text('name').notNull(),
    location: text('location'),
    /**
     * Existencia actual. Es el doblez de todos los movimientos del item, guardado en vez
     * de recalculado — el mismo trato de cache-aside que `metric_rollups` le da a los
     * agregados mensuales, y por la misma razón: la pantalla lo lee en cada carga y
     * sumar el ledger completo por SKU crecería sin techo.
     *
     * El precio de guardarlo es que puede desincronizarse del ledger, así que hay UN
     * solo escritor: `recordMovement()` en `modules/inventory/service.ts` inserta el
     * movimiento y actualiza esta columna en la MISMA transacción. Nada más escribe
     * `quantity_on_hand`. Un alta con existencia inicial > 0 también pasa por ahí, como
     * movimiento de apertura, para que el doblez cuadre desde la primera fila.
     */
    quantityOnHand: numeric('quantity_on_hand', { precision: 18, scale: 3 }).notNull().default('0'),
    /** Umbral de reposición: por debajo, la pantalla marca el SKU. */
    reorderPoint: numeric('reorder_point', { precision: 18, scale: 3 }).notNull().default('0'),
    /**
     * Costo unitario, con el mismo tratamiento de moneda que todo el dinero del sistema
     * (CLAUDE.md, no negociable): monto original + su moneda, monto convertido a la base
     * de la empresa, y el tipo de cambio congelado en la fila. Valorizar el inventario es
     * una cifra financiera que sale en pantalla junto a las demás; si esta sola se
     * guardara "en la moneda que sea", el valor total del inventario sumaría quetzales
     * con dólares.
     */
    unitCostOriginal: numeric('unit_cost_original', { precision: 18, scale: 2 })
      .notNull()
      .default('0'),
    unitCostCurrency: text('unit_cost_currency').$type<'GTQ' | 'USD'>().notNull(),
    unitCostBase: numeric('unit_cost_base', { precision: 18, scale: 2 }).notNull().default('0'),
    fxRate: numeric('fx_rate', { precision: 18, scale: 8 }).notNull().default('1'),
    fxRateDate: date('fx_rate_date').notNull(),
    supplier: text('supplier'),
    lastRestockDate: date('last_restock_date'),
    /**
     * Baja lógica, igual que en el ledger. Un SKU descontinuado no se puede borrar de
     * verdad sin dejar huérfano su historial de movimientos, que es justo lo que alguien
     * va a querer consultar cuando pregunte por qué se fue esa mercadería.
     */
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    companyIdx: index('inventory_items_company_idx').on(t.companyId),
    // Destino de la FK compuesta desde inventory_movements.
    companyIdUq: uniqueIndex('inventory_items_company_id_uq').on(t.companyId, t.id),
    // FK compuesta (incluye company_id) para que una referencia cross-tenant no exista.
    productFk: foreignKey({
      columns: [t.companyId, t.productId],
      foreignColumns: [products.companyId, products.id],
    }),
    // UNIQUE(company_id, lower(sku)) parcial sobre no borrados: va como índice de
    // expresión en la migración SQL, drizzle-kit no emite ni lower() ni WHERE.
  }),
);

/**
 * Ledger de movimientos de inventario: **append-only** (CLAUDE.md). Una corrección es un
 * movimiento de ajuste, no una edición del anterior — es exactamente el mismo criterio
 * que rige `credit_transactions`, y aquí importa igual: el historial de existencias es lo
 * que se revisa cuando falta mercadería, y un historial que se puede editar no sirve para
 * eso.
 *
 * La garantía real es el `REVOKE UPDATE, DELETE ... FROM macha_app` de la migración; el
 * rol dueño conserva DML implícito y eso no se puede revocar (no hay "FORCE" para
 * privilegios como sí lo hay para RLS), por eso la app corre como `macha_app`.
 */
export const inventoryMovements = pgTable(
  'inventory_movements',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id),
    itemId: uuid('item_id').notNull(),
    movementType: text('movement_type').$type<'in' | 'out' | 'adjustment'>().notNull(),
    /**
     * Siempre positiva; el signo lo pone `movement_type`. Guardar cantidades negativas y
     * un tipo a la vez permite que las dos se contradigan, y entonces hay que decidir
     * cuál gana en cada lectura. El CHECK de la migración obliga a > 0.
     *
     * Excepción deliberada: `adjustment` sí admite negativo, porque un ajuste de conteo
     * físico es "sobran 3" o "faltan 3" y forzarlo a un tipo `in`/`out` mentiría sobre lo
     * que pasó — no entró ni salió mercadería, se corrigió el libro.
     */
    quantity: numeric('quantity', { precision: 18, scale: 3 }).notNull(),
    /** Existencia resultante tras aplicar este movimiento: deja el historial auditable
     *  sin tener que re-doblar el ledger para saber cómo iba el conteo en cada punto. */
    quantityAfter: numeric('quantity_after', { precision: 18, scale: 3 }).notNull(),
    reason: text('reason'),
    /**
     * Carga de Excel que originó este movimiento (migración `0030`).
     *
     * `null` = registrado A MANO desde la pantalla de Inventario, que es el camino original y
     * el mayoritario. La distinción no es informativa: `revertDocument` compensa los
     * movimientos de la carga que se revierte, y no puede tocar el conteo físico que alguien
     * registró después a mano.
     *
     * Sin FK a `documents` a propósito: el movimiento es un hecho del ledger append-only y
     * debe sobrevivir aunque el documento se purgue. Es trazabilidad, no integridad.
     */
    documentId: uuid('document_id'),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    companyIdx: index('inventory_movements_company_idx').on(t.companyId),
    // El historial se lee siempre por item y en orden cronológico inverso.
    itemIdx: index('inventory_movements_company_item_idx').on(t.companyId, t.itemId, t.occurredAt),
    itemFk: foreignKey({
      columns: [t.companyId, t.itemId],
      foreignColumns: [inventoryItems.companyId, inventoryItems.id],
    }),
  }),
);
