import { eq, and, lte, desc } from 'drizzle-orm';
import type { DB } from '@/db/client';
import {
  stagingRows,
  documents,
  transactions,
  invoices,
  bills,
  fxRates,
  companies,
} from '@/db/schema';

export type PromotionResult =
  | { promoted: true; transactionCount: number; invoiceCount: number; billCount: number }
  | { promoted: false; reason: 'pending_rows' | 'no_rows' };

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

/** Fecha vigente ≤ la fecha dada (data model §4.10): la tasa más reciente que no sea
 * posterior. Moneda == moneda base de la empresa siempre resuelve a 1 (sin fila en
 * fx_rates necesaria). */
async function resolveFxRate(
  db: DB,
  companyId: string,
  quoteCurrency: 'GTQ' | 'USD',
  onOrBefore: string,
): Promise<{ rate: number; effectiveDate: string }> {
  const [company] = await db
    .select({ baseCurrency: companies.baseCurrency })
    .from(companies)
    .where(eq(companies.id, companyId));
  const base = company!.baseCurrency;

  if (quoteCurrency === base) {
    return { rate: 1, effectiveDate: onOrBefore };
  }

  const [fx] = await db
    .select()
    .from(fxRates)
    .where(
      and(
        eq(fxRates.companyId, companyId),
        eq(fxRates.baseCurrency, base),
        eq(fxRates.quoteCurrency, quoteCurrency),
        lte(fxRates.effectiveDate, onOrBefore),
      ),
    )
    .orderBy(desc(fxRates.effectiveDate))
    .limit(1);

  if (!fx) {
    throw new Error(
      `No fx_rate for company ${companyId}: ${quoteCurrency}->${base} on or before ${onOrBefore}`,
    );
  }
  return { rate: Number(fx.rate), effectiveDate: fx.effectiveDate };
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
    return { promoted: false, reason: 'no_rows' };
  }
  if (rows.some((r) => r.reviewStatus === 'pending' || r.reviewStatus === 'rejected')) {
    return { promoted: false, reason: 'pending_rows' };
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
