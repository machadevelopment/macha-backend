import { and, desc, eq, lte } from 'drizzle-orm';
import type { DB } from '@/db/client';
import { fxRates } from '@/db/schema';

/**
 * CU-868kjc6h1: catálogo de tasas de cambio por empresa. Hasta este ticket NADA en el
 * repositorio escribía en `fx_rates` — la tabla existía, con RLS e índices, y estaba
 * permanentemente vacía. `promotion.ts` la leía y, al no encontrar fila, tiraba el
 * upload COMPLETO (la promoción es atómica): una sola fila en USD en una empresa con
 * base GTQ dejaba fuera hasta las filas que sí estaban en GTQ.
 *
 * Este módulo concentra las tres cosas que antes vivían sueltas dentro de la promoción:
 * qué moneda puede necesitar tasa, cómo se resuelve la vigente, y qué se le dice a
 * quien tiene que arreglarlo.
 *
 * RETROACTIVIDAD (criterio 5 del ticket): registrar una tasa NO recalcula nada ya
 * promovido. `transactions`/`invoices`/`bills` congelan `fx_rate` + `fx_rate_date` por
 * fila en el momento de promover (data model §3), y esa foto es justamente lo que hace
 * auditable una cifra histórica. Una tasa nueva solo afecta a lo que se promueva
 * después. Corregir una conversión ya escrita es revertir la carga
 * (`POST /documents/:id/revert`) y volver a promoverla, no editar el pasado.
 */

export type Currency = 'GTQ' | 'USD';

export const CURRENCIES: readonly Currency[] = ['GTQ', 'USD'] as const;

/** La otra moneda del par soportado (PRD §8: el producto solo maneja GTQ y USD). */
export function counterCurrency(base: Currency): Currency {
  return base === 'GTQ' ? 'USD' : 'GTQ';
}

export type FxRateHit = { rate: number; effectiveDate: string };

/**
 * Tasa vigente ≤ la fecha dada (data model §4.10): la más reciente que no sea
 * posterior. La moneda base siempre resuelve a 1 sin necesidad de fila.
 */
export async function findFxRate(
  db: DB,
  companyId: string,
  base: Currency,
  quote: Currency,
  onOrBefore: string,
): Promise<FxRateHit | null> {
  if (quote === base) return { rate: 1, effectiveDate: onOrBefore };

  const [fx] = await db
    .select({ rate: fxRates.rate, effectiveDate: fxRates.effectiveDate })
    .from(fxRates)
    .where(
      and(
        eq(fxRates.companyId, companyId),
        eq(fxRates.baseCurrency, base),
        eq(fxRates.quoteCurrency, quote),
        lte(fxRates.effectiveDate, onOrBefore),
      ),
    )
    .orderBy(desc(fxRates.effectiveDate))
    .limit(1);

  return fx ? { rate: Number(fx.rate), effectiveDate: fx.effectiveDate } : null;
}

/**
 * Todas las tasas del par, de más reciente a más antigua. La ingesta clasifica cientos
 * de filas por lote y cada una tiene su propia fecha: resolverlas con una query por
 * fila serían cientos de round-trips dentro de la transacción del lote. El catálogo de
 * una empresa es de decenas de filas como mucho (lo mantiene un humano), así que cabe
 * entero en memoria.
 */
export async function loadFxCatalog(
  db: DB,
  companyId: string,
  base: Currency,
  quote: Currency,
): Promise<FxRateHit[]> {
  if (quote === base) return [];

  const rows = await db
    .select({ rate: fxRates.rate, effectiveDate: fxRates.effectiveDate })
    .from(fxRates)
    .where(
      and(
        eq(fxRates.companyId, companyId),
        eq(fxRates.baseCurrency, base),
        eq(fxRates.quoteCurrency, quote),
      ),
    )
    .orderBy(desc(fxRates.effectiveDate));

  return rows.map((r) => ({ rate: Number(r.rate), effectiveDate: r.effectiveDate }));
}

/** Misma semántica que `findFxRate` pero contra un catálogo ya cargado (ordenado desc). */
export function resolveFromCatalog(catalog: FxRateHit[], onOrBefore: string): FxRateHit | null {
  return catalog.find((r) => r.effectiveDate <= onOrBefore) ?? null;
}

/**
 * El mensaje que ve un humano cuando falta la tasa. Antes era
 * `No fx_rate for company <uuid>: USD->GTQ on or before 2026-07-01` — técnicamente
 * exacto y operativamente inútil: no decía qué hacer ni dónde. El `company_id` sale
 * (quien lee el monitoreo de uploads ya está mirando la fila de esa empresa) y entra
 * la acción concreta (criterio 3).
 */
export function missingFxRateMessage(params: {
  quote: Currency;
  base: Currency;
  onOrBefore: string;
}): string {
  return (
    `Falta la tasa de cambio ${params.quote}→${params.base} vigente al ${params.onOrBefore}. ` +
    `Regístrala en el panel admin (Empresa › Tasas de cambio) con una fecha de vigencia ` +
    `igual o anterior a esa y vuelve a procesar la carga.`
  );
}

/** Prefijo de `staging_rows.flag_reason` para una fila que no se puede convertir. */
export const MISSING_FX_FLAG = 'missing_fx_rate';

export function missingFxFlagReason(quote: Currency, onOrBefore: string): string {
  return `${MISSING_FX_FLAG}:${quote}:${onOrBefore}`;
}
