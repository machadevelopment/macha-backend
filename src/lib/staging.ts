import { eq } from 'drizzle-orm';
import type { DB } from '@/db/client';
import { companies, stagingRows } from '@/db/schema';
import { evaluateFlagReason, type MappedRow } from './staging-rules';
import {
  counterCurrency,
  loadFxCatalog,
  missingFxFlagReason,
  resolveFromCatalog,
  type Currency,
  type FxRateHit,
} from './fx';

/** La fecha por la que se convierte cada entidad (misma que usa `promoteDocument`). */
function conversionDate(row: MappedRow): unknown {
  const p = row.payload as { date?: unknown; issueDate?: unknown };
  return row.targetEntity === 'transaction' ? p.date : p.issueDate;
}

/**
 * CU-868kjc6h1: una fila en moneda extranjera sin tasa vigente se marca para revisión
 * en vez de dejar que reviente la promoción.
 *
 * Por qué aquí y no en `evaluateFlagReason`: esa función es pura y se prueba sin base;
 * esto necesita el catálogo de `fx_rates` de la empresa. Se carga UNA vez por lote y se
 * resuelve en memoria.
 *
 * El efecto de marcarla es lo importante: `promoteDocument` se niega a promover mientras
 * queden filas `pending`, así que el documento queda en `review` con las filas intactas
 * — nada se pierde. En cuanto alguien registra la tasa y resuelve la fila, la promoción
 * atómica corre con todo el documento. Antes, la misma situación tiraba un `Error` desde
 * la promoción, marcaba el documento `failed` y pg-boss lo reintentaba 3 veces contra la
 * misma causa determinista.
 */
async function flagMissingFxRates(
  db: DB,
  companyId: string,
  rows: { row: MappedRow; flagReason: string | null }[],
): Promise<void> {
  const candidates = rows.filter((r) => r.flagReason === null);
  if (candidates.length === 0) return;

  const [company] = await db
    .select({ baseCurrency: companies.baseCurrency })
    .from(companies)
    .where(eq(companies.id, companyId));
  if (!company) return;

  const base = company.baseCurrency as Currency;
  const quote = counterCurrency(base);

  let catalog: FxRateHit[] | null = null;

  for (const candidate of candidates) {
    const currency = (candidate.row.payload as { originalCurrency?: unknown }).originalCurrency;
    if (currency !== quote) continue; // moneda base: convierte a 1, nunca necesita fila

    const date = conversionDate(candidate.row);
    if (typeof date !== 'string') continue; // fecha inválida ya la marcó la regla pura

    // Perezoso a propósito: la mayoría de los lotes son 100% moneda base y entonces esta
    // query no llega a correr.
    catalog ??= await loadFxCatalog(db, companyId, base, quote);

    if (!resolveFromCatalog(catalog, date)) {
      candidate.flagReason = missingFxFlagReason(quote, date);
    }
  }
}

/**
 * Inserts extracted rows into staging_rows, applying the flag rules (CU-868kfva9q):
 * by validation rules and by model confidence. Called by the worker (CU-868kfva8v)
 * after each Claude call for a sheet/batch — one INSERT per batch, not per row.
 */
export async function insertStagingRows(
  db: DB,
  companyId: string,
  documentId: string,
  rows: MappedRow[],
  /**
   * De qué hoja del Excel salieron estas filas (migración 0039).
   *
   * OPCIONAL a propósito: los tests que solo ejercitan la promoción no tienen por qué
   * inventarse un nombre de hoja, y una carga anterior a la migración lo tiene en NULL. Lo que
   * NO puede pasar es que el worker se lo olvide — sin esto el cuadre por hoja no existe, y el
   * cuadre por documento deja pasar el caso que más daño hace: una hoja al doble y otra en
   * cero se cancelan en el total.
   */
  sheetName?: string,
): Promise<void> {
  if (rows.length === 0) return;

  const evaluated = rows.map((row) => ({ row, flagReason: evaluateFlagReason(row) }));
  await flagMissingFxRates(db, companyId, evaluated);

  await db.insert(stagingRows).values(
    evaluated.map(({ row, flagReason }) => ({
      companyId,
      documentId,
      targetEntity: row.targetEntity,
      payload: row.payload,
      confidence: row.confidence.toFixed(4),
      flagReason,
      reviewStatus: flagReason ? ('pending' as const) : ('clean' as const),
      ...(sheetName ? { sheetName } : {}),
    })),
  );
}
