import { and, eq, gte, isNull, lte, sql as rawSql } from 'drizzle-orm';
import type { DB } from '@/db/client';
import { transactions } from '@/db/schema';
import type { Currency } from '@/lib/fx';

/**
 * Composición por MONEDA ORIGINAL de un período, con la tasa que se aplicó — CU-868kj3gnv.
 *
 * ═══════════════════════════════════════════════════════════════════════════════════════
 * POR QUÉ ESTO Y NO UN "CONVERSOR": EL CRITERIO 3 DEL TICKET REFUTA AL CRITERIO 1
 * ═══════════════════════════════════════════════════════════════════════════════════════
 *
 * El ticket pide dos cosas que no pueden ser ciertas a la vez, y conviene dejar escrito por
 * qué antes de que alguien "arregle" esto convirtiéndolo todo:
 *
 *   · criterio 1: "alternar la moneda mostrada entre la base y la secundaria";
 *   · criterio 3: "la conversión reutiliza la tasa ya congelada por transacción, sin
 *     recalcular con una tasa distinta a la que se usó al ingerir".
 *
 * Una fila que entró en USD tiene las dos caras guardadas (`original_amount` en USD,
 * `amount_base` en GTQ, y su `fx_rate`), así que para ELLA la ida y vuelta es exacta. Pero
 * una fila que entró en GTQ tiene `fx_rate = 1`: **no existe una tasa congelada que la
 * exprese en USD**. Para "mostrar todo el dashboard en USD" habría que inventar una tasa
 * para esas filas — exactamente lo que el criterio 3 prohíbe.
 *
 * O sea que el toggle "todo en la otra moneda" no es una funcionalidad que falte: es una
 * cifra que no existe. Convertir igual daría un número que no es ninguna de las dos monedas,
 * presentado como si fuera plata de verdad.
 *
 * Lo que SÍ es cierto y es lo que el PRD promete de verdad (§6: "la moneda aplicada, la tasa
 * usada... son siempre visibles") es esto: el período partido POR MONEDA ORIGINAL, cada
 * parte en su propia moneda y sin sumarse entre sí, con la tasa que se le aplicó y su fecha.
 *
 * Es además el precedente que el producto YA tomó en la pantalla de conceptos pendientes:
 * "los montos van SEPARADOS por moneda, nunca sumados; sumar GTQ con USD daría un número que
 * no es ninguna de las dos".
 *
 * ═══ LA TASA SE REPORTA COMO RANGO, NO COMO NÚMERO ═══
 *
 * Cada fila congela SU tasa el día que se promovió, así que un período de un mes puede tener
 * decenas de tasas distintas. Devolver una sola —la última, o un promedio— sería una cifra
 * que no se aplicó a la mayoría de las filas. Se devuelve `min`, `max` y la `última` con su
 * fecha: si min === max hay una sola tasa y la interfaz la escribe a secas; si difieren, el
 * cliente tiene que ver que hubo variación, porque es justo lo que hace que el consolidado
 * no sea reproducible con una regla de tres.
 */
export interface CurrencyBreakdownRow {
  currency: Currency;
  /** Suma en la moneda ORIGINAL. Nunca se suma con la de otra fila de esta lista. */
  originalTotal: number;
  /** Lo que esa moneda aportó al consolidado en base. Esto sí es sumable entre filas. */
  baseTotal: number;
  transactionCount: number;
  /** `null` para la moneda base: su tasa es 1 y escribirla sería ruido. */
  rate: { min: number; max: number; latest: number; latestDate: string } | null;
}

export interface CurrencyComposition {
  baseCurrency: Currency;
  rows: CurrencyBreakdownRow[];
  /**
   * Si es `false`, el frontend NO pinta el control (criterio 4: "no agregar ruido donde no
   * aporta"). Se decide acá y no en el cliente para que haya UNA definición de "esta empresa
   * es multi-moneda" — la pantalla de reportes y el dashboard tienen que coincidir.
   */
  multiCurrency: boolean;
}

export async function currencyComposition(
  db: DB,
  companyId: string,
  baseCurrency: Currency,
  from: string,
  to: string,
): Promise<CurrencyComposition> {
  const filas = await db
    .select({
      currency: transactions.originalCurrency,
      originalTotal: rawSql<string>`sum(${transactions.originalAmount})`,
      baseTotal: rawSql<string>`sum(${transactions.amountBase})`,
      transactionCount: rawSql<string>`count(*)`,
      rateMin: rawSql<string>`min(${transactions.fxRate})`,
      rateMax: rawSql<string>`max(${transactions.fxRate})`,
      // La tasa de la fila MÁS RECIENTE, no la mayor: `max(fx_rate)` daría la tasa más alta
      // del período, que puede ser de enero. Se ordena por fecha y se toma la primera.
      rateLatest: rawSql<string>`(array_agg(${transactions.fxRate} order by ${transactions.fxRateDate} desc))[1]`,
      rateLatestDate: rawSql<string>`max(${transactions.fxRateDate})`,
    })
    .from(transactions)
    .where(
      and(
        eq(transactions.companyId, companyId),
        isNull(transactions.deletedAt),
        gte(transactions.date, from),
        lte(transactions.date, to),
      ),
    )
    .groupBy(transactions.originalCurrency)
    .orderBy(rawSql`sum(${transactions.amountBase}) desc`);

  const rows: CurrencyBreakdownRow[] = filas.map((f) => {
    const esBase = f.currency === baseCurrency;
    return {
      currency: f.currency as Currency,
      originalTotal: Number(f.originalTotal),
      baseTotal: Number(f.baseTotal),
      transactionCount: Number(f.transactionCount),
      rate: esBase
        ? null
        : {
            min: Number(f.rateMin),
            max: Number(f.rateMax),
            latest: Number(f.rateLatest),
            latestDate: String(f.rateLatestDate),
          },
    };
  });

  /*
   * "Multi-moneda" es que haya movimiento REAL en una moneda distinta de la base, no que
   * exista una fila. Un período donde la única transacción en USD suma cero —una nota de
   * crédito que cancela su factura— no justifica pintarle al cliente un control de moneda.
   */
  const multiCurrency = rows.some((r) => r.currency !== baseCurrency && r.originalTotal !== 0);

  return { baseCurrency, rows, multiCurrency };
}
