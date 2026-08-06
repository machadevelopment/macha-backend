import { eq, and } from 'drizzle-orm';
import type { DB } from '@/db/client';
import { stagingRows, documents, transactions, invoices, bills, companies } from '@/db/schema';
import { findFxRate, missingFxRateMessage, type Currency } from '@/lib/fx';
import { ProductResolver } from '@/lib/product-dimension';

export type PromotionResult =
  | { promoted: true; transactionCount: number; invoiceCount: number; billCount: number }
  | {
      promoted: false;
      reason: 'pending_rows' | 'no_rows';
      /**
       * CU-868kn5hqu: cuántas filas están frenando la promoción. Antes esto no salía de
       * aquí, así que `documents.flagged_count` quedaba en NULL y el cliente veía su
       * dashboard en cero sin forma de saber que su carga estaba esperando revisión —
       * ni cuánto faltaba. Un libro real dejó 542 filas marcadas y el producto se leía
       * como roto.
       */
      pendingCount: number;
    };

type TransactionPayload = {
  type: 'revenue' | 'cogs' | 'opex' | 'other';
  category: string;
  date: string;
  description?: string;
  originalAmount: number;
  originalCurrency: 'GTQ' | 'USD';
  /** Nombre del producto cuando la fila lo trae; `null` si no aplica. */
  product?: string | null;
  /** Unidades de la fila; `null` cuando la fila no habla de unidades. */
  quantity?: number | null;
  /** Familia comercial del producto; distinta de `category`, que clasifica el movimiento. */
  productCategory?: string | null;
};

type InvoiceLikePayload = {
  counterparty: string;
  issueDate: string;
  dueDate?: string;
  originalAmount: number;
  originalCurrency: 'GTQ' | 'USD';
};

/** originalAmount * fxRate -> amountBase, como string (columna numeric — nunca
 * float, data model §3/CLAUDE.md). Extraída como función pura para poder probar la
 * conversión de moneda sin una fila real de staging_rows/fx_rates. */
export function computeAmountBase(originalAmount: number, fxRate: number): string {
  return String(originalAmount * fxRate);
}

/**
 * Unidades de la fila -> columna `numeric` (string) o NULL.
 *
 * Todo lo que no sea un número positivo y finito se convierte en NULL en vez de tumbar la
 * promoción. La cantidad es un dato de enriquecimiento: si la IA devuelve 0, un negativo o
 * basura, la respuesta correcta es "no sabemos cuántas unidades", no perder el movimiento
 * financiero —que sí está bien— por un campo accesorio. El CHECK
 * `transactions_quantity_chk` de la migración 0019 rechazaría esos valores de todas
 * formas, y ahí el fallo sería de la carga entera: la promoción es atómica, una fila mala
 * arrastra el documento completo.
 *
 * Se exporta para poder probar esa frontera sin montar una promoción con Postgres.
 */
export function normalizeQuantity(quantity: number | null | undefined): string | null {
  if (typeof quantity !== 'number' || !Number.isFinite(quantity) || quantity <= 0) return null;
  return String(quantity);
}

/**
 * Resuelve la tasa vigente o falla con un mensaje accionable.
 *
 * CU-868kjc6h1 criterio 3: el error que llega a `documents.error_reason` —lo que el
 * staff ve en el monitoreo de uploads— decía `No fx_rate for company <uuid>:
 * USD->GTQ on or before 2026-07-01`. Exacto y sin salida: no decía qué hacer. Ahora el
 * texto viene de `missingFxRateMessage` y nombra la acción concreta. La lógica de
 * lookup vive en `lib/fx.ts` porque la ingesta la necesita antes, para marcar la fila
 * en vez de tumbar la carga entera.
 */
async function resolveFxRate(
  db: DB,
  companyId: string,
  quoteCurrency: Currency,
  onOrBefore: string,
): Promise<{ rate: number; effectiveDate: string }> {
  const [company] = await db
    .select({ baseCurrency: companies.baseCurrency })
    .from(companies)
    .where(eq(companies.id, companyId));
  const base = company!.baseCurrency;

  const fx = await findFxRate(db, companyId, base, quoteCurrency, onOrBefore);
  if (!fx) {
    throw new Error(missingFxRateMessage({ quote: quoteCurrency, base, onOrBefore }));
  }
  return fx;
}

/**
 * Atomic promotion (CU-868kfva9z): staging_rows -> transactions/invoices/bills, all
 * or nothing. The caller's `db` MUST already be inside a transaction — the worker
 * (CU-868kfva8v) uses withCompanyScope, which wraps the whole job in begin/commit/
 * rollback, so a throw here rolls back every insert. Refuses to promote while any row
 * for this document is still pending/rejected (data model §16: "ninguna fila se
 * promueve mientras existan flag_reason sin resolver").
 */
export async function promoteDocument(
  db: DB,
  companyId: string,
  documentId: string,
): Promise<PromotionResult> {
  const rows = await db
    .select()
    .from(stagingRows)
    .where(and(eq(stagingRows.companyId, companyId), eq(stagingRows.documentId, documentId)));

  if (rows.length === 0) {
    return { promoted: false, reason: 'no_rows', pendingCount: 0 };
  }
  const pendientes = rows.filter(
    (r) => r.reviewStatus === 'pending' || r.reviewStatus === 'rejected',
  ).length;
  if (pendientes > 0) {
    return { promoted: false, reason: 'pending_rows', pendingCount: pendientes };
  }

  let transactionCount = 0;
  let invoiceCount = 0;
  let billCount = 0;

  // Un resolvedor por promoción: su caché evita repetir consultas para el mismo
  // producto, que en un libro de ventas se repite en cientos de filas.
  const productos = new ProductResolver(db, companyId);

  for (const row of rows) {
    if (row.targetEntity === 'transaction') {
      const p = row.payload as unknown as TransactionPayload;
      const fx = await resolveFxRate(db, companyId, p.originalCurrency, p.date);
      const productId = await productos.resolve(p.product, p.productCategory);
      await db.insert(transactions).values({
        companyId,
        documentId,
        productId,
        quantity: normalizeQuantity(p.quantity),
        date: p.date,
        type: p.type,
        category: p.category,
        description: p.description ?? null,
        originalAmount: String(p.originalAmount),
        originalCurrency: p.originalCurrency,
        amountBase: computeAmountBase(p.originalAmount, fx.rate),
        fxRate: String(fx.rate),
        fxRateDate: fx.effectiveDate,
      });
      transactionCount++;
    } else {
      const p = row.payload as unknown as InvoiceLikePayload;
      const fx = await resolveFxRate(db, companyId, p.originalCurrency, p.issueDate);
      const values = {
        companyId,
        documentId,
        counterparty: p.counterparty,
        issueDate: p.issueDate,
        dueDate: p.dueDate ?? null,
        originalAmount: String(p.originalAmount),
        originalCurrency: p.originalCurrency,
        amountBase: computeAmountBase(p.originalAmount, fx.rate),
        fxRate: String(fx.rate),
        fxRateDate: fx.effectiveDate,
        status: 'open' as const,
      };
      if (row.targetEntity === 'invoice') {
        await db.insert(invoices).values(values);
        invoiceCount++;
      } else {
        await db.insert(bills).values(values);
        billCount++;
      }
    }
  }

  await db
    .update(documents)
    .set({ status: 'promoted', promotedAt: new Date(), rowCount: rows.length, flaggedCount: 0 })
    .where(eq(documents.id, documentId));

  return { promoted: true, transactionCount, invoiceCount, billCount };
}

/**
 * Revert (CU-868kfva9z): soft-delete every business row created from this document,
 * preserving the audit trail (data model §16). `documents` keeps its history —
 * status flips to 'reverted', nothing is deleted.
 */
export async function revertDocument(db: DB, companyId: string, documentId: string): Promise<void> {
  const now = new Date();
  const match = and(eq(transactions.companyId, companyId), eq(transactions.documentId, documentId));

  await db.update(transactions).set({ deletedAt: now }).where(match);
  await db
    .update(invoices)
    .set({ deletedAt: now })
    .where(and(eq(invoices.companyId, companyId), eq(invoices.documentId, documentId)));
  await db
    .update(bills)
    .set({ deletedAt: now })
    .where(and(eq(bills.companyId, companyId), eq(bills.documentId, documentId)));
  await db
    .update(documents)
    .set({ status: 'reverted', revertedAt: now })
    .where(eq(documents.id, documentId));
}
