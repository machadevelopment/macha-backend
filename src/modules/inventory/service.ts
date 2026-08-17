import { and, eq, isNull, sql as rawSql } from 'drizzle-orm';
import type { DB } from '@/db/client';
import { inventoryItems, inventoryMovements, companies } from '@/db/schema';
import { findFxRate, missingFxRateMessage, type Currency } from '@/lib/fx';

export type MovementType = 'in' | 'out' | 'adjustment';

/**
 * Error de negocio del inventario. Se distingue de un fallo técnico para que la ruta
 * devuelva 400 con un mensaje que el usuario pueda accionar, en vez de un 500 opaco: "el
 * SKU CAFE-500 ya existe" es algo que la persona corrige sola, y un 500 la deja adivinando
 * si el sistema se cayó.
 */
export class InventoryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InventoryError';
  }
}

/**
 * Convierte el costo unitario a la moneda base de la empresa y congela el tipo de cambio.
 *
 * Es el mismo trato que `lib/promotion.ts` le da a cada fila del ledger, y no un adorno:
 * sin él, el valor total del inventario sumaría quetzales con dólares. Cuando la moneda
 * del costo YA es la base, no se busca tasa alguna (rate = 1) — exigir una fila de
 * `fx_rates` para un costo en quetzales de una empresa que factura en quetzales bloquearía
 * el alta de items por una tasa que nadie necesita.
 */
async function convertirCosto(
  db: DB,
  companyId: string,
  unitCost: number,
  currency: Currency,
  onOrBefore: string,
): Promise<{ base: string; rate: string; rateDate: string }> {
  const [company] = await db
    .select({ baseCurrency: companies.baseCurrency })
    .from(companies)
    .where(eq(companies.id, companyId));
  const base = (company?.baseCurrency ?? 'GTQ') as Currency;

  if (currency === base) {
    return { base: String(unitCost), rate: '1', rateDate: onOrBefore };
  }

  const fx = await findFxRate(db, companyId, base, currency, onOrBefore);
  if (!fx) {
    throw new InventoryError(missingFxRateMessage({ quote: currency, base, onOrBefore }));
  }
  return {
    base: String(unitCost * fx.rate),
    rate: String(fx.rate),
    rateDate: fx.effectiveDate,
  };
}

/** Fecha de hoy en UTC, `YYYY-MM-DD`. */
function hoy(): string {
  return new Date().toISOString().slice(0, 10);
}

export interface CreateItemInput {
  /** Ver `RecordMovementInput.documentId`: viaja al movimiento de apertura. */
  documentId?: string | null;
  sku: string;
  name: string;
  productId?: string | null;
  location?: string | null;
  quantityOnHand?: number;
  reorderPoint?: number;
  unitCost?: number;
  unitCostCurrency?: Currency;
  supplier?: string | null;
}

/**
 * Alta de un SKU. Si nace con existencia, esa existencia entra como movimiento de
 * apertura — NO como un simple valor en la columna.
 *
 * Es deliberado y es la mitad del contrato de `quantity_on_hand`: la columna es el doblez
 * del ledger de movimientos, así que una existencia inicial sin su movimiento sería un
 * saldo que ningún movimiento explica. La primera vez que alguien pregunte "¿de dónde
 * salieron estas 40 unidades?", el historial tiene que poder contestar.
 */
export async function createItem(
  db: DB,
  companyId: string,
  userId: string,
  input: CreateItemInput,
): Promise<{ id: string }> {
  const sku = input.sku.trim();
  const name = input.name.trim();
  if (!sku) throw new InventoryError('El SKU no puede ir vacío.');
  if (!name) throw new InventoryError('El nombre no puede ir vacío.');

  const inicial = input.quantityOnHand ?? 0;
  if (inicial < 0) throw new InventoryError('La existencia inicial no puede ser negativa.');

  const fecha = hoy();
  const costo = await convertirCosto(
    db,
    companyId,
    input.unitCost ?? 0,
    input.unitCostCurrency ?? 'GTQ',
    fecha,
  );

  // Se comprueba antes de insertar para poder dar un mensaje con el SKU adentro. El índice
  // único parcial sobre lower(sku) sigue siendo la garantía real — esto es la cortesía.
  const [duplicado] = await db
    .select({ id: inventoryItems.id })
    .from(inventoryItems)
    .where(
      and(
        eq(inventoryItems.companyId, companyId),
        isNull(inventoryItems.deletedAt),
        rawSql`lower(${inventoryItems.sku}) = ${sku.toLowerCase()}`,
      ),
    )
    .limit(1);
  if (duplicado) throw new InventoryError(`Ya existe un artículo con el SKU "${sku}".`);

  const [creado] = await db
    .insert(inventoryItems)
    .values({
      companyId,
      productId: input.productId ?? null,
      sku,
      name,
      location: input.location?.trim() || null,
      // Arranca en 0 SIEMPRE: la existencia inicial la aplica el movimiento de apertura de
      // abajo, que es el único camino que escribe esta columna.
      quantityOnHand: '0',
      reorderPoint: String(input.reorderPoint ?? 0),
      unitCostOriginal: String(input.unitCost ?? 0),
      unitCostCurrency: input.unitCostCurrency ?? 'GTQ',
      unitCostBase: costo.base,
      fxRate: costo.rate,
      fxRateDate: costo.rateDate,
      supplier: input.supplier?.trim() || null,
      lastRestockDate: inicial > 0 ? fecha : null,
    })
    .returning({ id: inventoryItems.id });

  if (inicial > 0) {
    await recordMovement(db, companyId, userId, {
      itemId: creado!.id,
      movementType: 'in',
      quantity: inicial,
      reason: 'Existencia inicial',
      documentId: input.documentId ?? null,
    });
  }

  return { id: creado!.id };
}

export interface RecordMovementInput {
  itemId: string;
  movementType: MovementType;
  quantity: number;
  reason?: string | null;
  /**
   * Carga de Excel que lo originó (CU-868krkfrh). `undefined` en todo movimiento manual, que
   * es el camino original. Es lo que permite a `revertDocument` deshacer el inventario de una
   * carga revertida sin tocar los conteos que alguien registró a mano después.
   */
  documentId?: string | null;
}

/**
 * **El único escritor de `quantity_on_hand`.** Inserta el movimiento y actualiza la
 * existencia en la MISMA transacción; nada más en el código toca esa columna.
 *
 * Es lo que sostiene que el saldo guardado sea realmente el doblez del ledger. Si un
 * segundo camino pudiera escribirlo, la desincronización sería cuestión de tiempo y no
 * habría forma de saber cuál de los dos números es el bueno.
 *
 * El caller DEBE venir dentro de una transacción (las rutas usan `withCompanyScope`, que
 * envuelve la request completa): si el UPDATE falla después del INSERT, el movimiento no
 * puede quedar registrado sin haberse aplicado.
 *
 * La existencia se actualiza con aritmética EN SQL (`quantity_on_hand + $1`) y no leyendo
 * el valor en JS para volver a escribirlo. Dos personas registrando salidas del mismo SKU
 * a la vez se perderían una lectura con lo segundo; en SQL el incremento lo resuelve
 * Postgres sobre la fila bloqueada.
 */
export async function recordMovement(
  db: DB,
  companyId: string,
  userId: string,
  input: RecordMovementInput,
): Promise<{ id: string; quantityAfter: number }> {
  if (!Number.isFinite(input.quantity)) {
    throw new InventoryError('La cantidad debe ser un número.');
  }
  if (input.movementType !== 'adjustment' && input.quantity <= 0) {
    throw new InventoryError('Una entrada o salida debe tener cantidad mayor que cero.');
  }
  if (input.movementType === 'adjustment' && input.quantity === 0) {
    throw new InventoryError('Un ajuste de cero no cambia nada.');
  }

  const [item] = await db
    .select({ id: inventoryItems.id })
    .from(inventoryItems)
    .where(
      and(
        eq(inventoryItems.companyId, companyId),
        eq(inventoryItems.id, input.itemId),
        isNull(inventoryItems.deletedAt),
      ),
    )
    .limit(1);
  if (!item) throw new InventoryError('El artículo no existe o fue dado de baja.');

  // El signo lo pone el tipo, no la cantidad (ver el CHECK de la migración 0019).
  const delta = input.movementType === 'out' ? -input.quantity : input.quantity;

  const [actualizado] = await db
    .update(inventoryItems)
    .set({
      quantityOnHand: rawSql`${inventoryItems.quantityOnHand} + ${String(delta)}`,
      // Solo una entrada real cuenta como reabastecimiento; un ajuste positivo es una
      // corrección de conteo y fecharlo como reposición mentiría sobre cuándo llegó
      // mercadería por última vez.
      ...(input.movementType === 'in' ? { lastRestockDate: hoy() } : {}),
      updatedAt: new Date(),
    })
    .where(and(eq(inventoryItems.companyId, companyId), eq(inventoryItems.id, input.itemId)))
    .returning({ quantityOnHand: inventoryItems.quantityOnHand });

  const quantityAfter = Number(actualizado!.quantityOnHand);

  const [movimiento] = await db
    .insert(inventoryMovements)
    .values({
      companyId,
      itemId: input.itemId,
      movementType: input.movementType,
      quantity: String(input.quantity),
      quantityAfter: String(quantityAfter),
      reason: input.reason?.trim() || null,
      documentId: input.documentId ?? null,
      createdBy: userId,
    })
    .returning({ id: inventoryMovements.id });

  return { id: movimiento!.id, quantityAfter };
}

export interface UpdateItemInput {
  name?: string;
  productId?: string | null;
  location?: string | null;
  reorderPoint?: number;
  unitCost?: number;
  unitCostCurrency?: Currency;
  supplier?: string | null;
}

/**
 * Edita los datos descriptivos del SKU. **No toca la existencia**: cambiar el stock es
 * registrar un movimiento, no editar un número.
 *
 * Es la regla que hace que el historial sirva. Si esta función admitiera
 * `quantityOnHand`, existiría un camino para cambiar la existencia sin dejar rastro de por
 * qué cambió, y el ledger append-only de al lado dejaría de contar la historia completa.
 * Un conteo físico que no cuadra se corrige con un movimiento de tipo `adjustment`.
 */
export async function updateItem(
  db: DB,
  companyId: string,
  itemId: string,
  input: UpdateItemInput,
): Promise<void> {
  const [item] = await db
    .select({
      unitCostCurrency: inventoryItems.unitCostCurrency,
      unitCostOriginal: inventoryItems.unitCostOriginal,
    })
    .from(inventoryItems)
    .where(
      and(
        eq(inventoryItems.companyId, companyId),
        eq(inventoryItems.id, itemId),
        isNull(inventoryItems.deletedAt),
      ),
    )
    .limit(1);
  if (!item) throw new InventoryError('El artículo no existe o fue dado de baja.');

  const cambios: Record<string, unknown> = { updatedAt: new Date() };

  if (input.name !== undefined) {
    const name = input.name.trim();
    if (!name) throw new InventoryError('El nombre no puede ir vacío.');
    cambios.name = name;
  }
  if (input.productId !== undefined) cambios.productId = input.productId;
  if (input.location !== undefined) cambios.location = input.location?.trim() || null;
  if (input.supplier !== undefined) cambios.supplier = input.supplier?.trim() || null;
  if (input.reorderPoint !== undefined) {
    if (input.reorderPoint < 0)
      throw new InventoryError('El punto de reorden no puede ser negativo.');
    cambios.reorderPoint = String(input.reorderPoint);
  }

  // El costo se re-convierte con la tasa de HOY, no con la que traía la fila. Es un costo
  // nuevo: reutilizar el tipo de cambio viejo mezclaría el precio de esta compra con la
  // tasa de la anterior y el valor del inventario dejaría de cuadrar con lo que se pagó.
  if (input.unitCost !== undefined || input.unitCostCurrency !== undefined) {
    const monto = input.unitCost ?? Number(item.unitCostOriginal);
    const moneda = (input.unitCostCurrency ?? item.unitCostCurrency) as Currency;
    if (monto < 0) throw new InventoryError('El costo unitario no puede ser negativo.');
    const costo = await convertirCosto(db, companyId, monto, moneda, hoy());
    cambios.unitCostOriginal = String(monto);
    cambios.unitCostCurrency = moneda;
    cambios.unitCostBase = costo.base;
    cambios.fxRate = costo.rate;
    cambios.fxRateDate = costo.rateDate;
  }

  await db
    .update(inventoryItems)
    .set(cambios)
    .where(and(eq(inventoryItems.companyId, companyId), eq(inventoryItems.id, itemId)));
}

/**
 * Baja lógica. No hay borrado físico: el historial de movimientos referencia este item por
 * FK, y lo que alguien va a querer consultar cuando pregunte por mercadería faltante es
 * justo ese historial.
 */
export async function discontinueItem(db: DB, companyId: string, itemId: string): Promise<void> {
  const resultado = await db
    .update(inventoryItems)
    .set({ deletedAt: new Date(), updatedAt: new Date() })
    .where(
      and(
        eq(inventoryItems.companyId, companyId),
        eq(inventoryItems.id, itemId),
        isNull(inventoryItems.deletedAt),
      ),
    )
    .returning({ id: inventoryItems.id });

  if (resultado.length === 0)
    throw new InventoryError('El artículo no existe o ya fue dado de baja.');
}
