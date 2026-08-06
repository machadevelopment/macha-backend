import { eq, and } from 'drizzle-orm';
import type { DB } from '@/db/client';
import { stagingRows, documents, transactions, invoices, bills, companies } from '@/db/schema';
import { findFxRate, missingFxRateMessage, type Currency } from '@/lib/fx';

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

  for (const row of rows) {
    if (row.targetEntity === 'transaction') {
      const p = row.payload as unknown as TransactionPayload;
      const fx = await resolveFxRate(db, companyId, p.originalCurrency, p.date);
      await db.insert(transactions).values({
        companyId,
        documentId,
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
