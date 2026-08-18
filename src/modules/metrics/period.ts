import { and, eq, gte, isNull, lte, sql as rawSql } from 'drizzle-orm';
import type { DB } from '@/db/client';
import { transactions } from '@/db/schema';

/**
 * Totales y serie diaria para un rango ARBITRARIO de fechas — lo que necesita el filtro
 * de período del dashboard (Hoy / Semana / Mes / Año / Personalizado).
 *
 * POR QUÉ NO SIRVEN LOS ROLLUPS. `metric_rollups` agrega por mes (y trimestre/año), que
 * es exactamente lo que el filtro rompe: "esta semana" y "hoy" no son múltiplos de un
 * mes, y un rango personalizado casi nunca cae en bordes de mes. Forzarlo al molde
 * mensual daría cifras que no corresponden al rango que el usuario eligió, que es peor
 * que ser lento. Se consulta el ledger directo, igual que hace `computeReportMetrics`
 * para el rango exacto de un reporte.
 *
 * `deleted_at IS NULL` en las dos consultas: un documento revertido no debe seguir
 * contando en los KPIs.
 */

export interface PeriodTotals {
  revenue: number;
  cogs: number;
  opex: number;
  other: number;
}

export interface PeriodPoint extends PeriodTotals {
  date: string;
}

const VACIO: PeriodTotals = { revenue: 0, cogs: 0, opex: 0, other: 0 };

async function totalesPorTipo(
  db: DB,
  companyId: string,
  from: string,
  to: string,
): Promise<PeriodTotals> {
  const filas = await db
    .select({ type: transactions.type, total: rawSql<string>`sum(${transactions.amountBase})` })
    .from(transactions)
    .where(
      and(
        eq(transactions.companyId, companyId),
        isNull(transactions.deletedAt),
        gte(transactions.date, from),
        lte(transactions.date, to),
      ),
    )
    .groupBy(transactions.type);

  const totales: PeriodTotals = { ...VACIO };
  for (const f of filas) totales[f.type as keyof PeriodTotals] = Number(f.total);
  return totales;
}

/**
 * Ventana anterior de la MISMA longitud, terminando el día antes de `from`.
 *
 * Se calcula por duración y no por "mes anterior" a propósito: el filtro admite rangos
 * personalizados, y comparar 12 días contra un mes entero daría un delta sin sentido que
 * además se leería como una caída enorme. La regla es siempre "el mismo tamaño, justo
 * antes".
 */
export function ventanaAnterior(from: string, to: string): { from: string; to: string } {
  const inicio = new Date(`${from}T00:00:00Z`);
  const fin = new Date(`${to}T00:00:00Z`);
  const dias = Math.round((fin.getTime() - inicio.getTime()) / 86_400_000) + 1;

  const finPrevio = new Date(inicio.getTime() - 86_400_000);
  const inicioPrevio = new Date(finPrevio.getTime() - (dias - 1) * 86_400_000);

  return {
    from: inicioPrevio.toISOString().slice(0, 10),
    to: finPrevio.toISOString().slice(0, 10),
  };
}

/** Serie DIARIA dentro del rango. La UI decide si la muestra completa o la agrupa. */
async function seriePorDia(
  db: DB,
  companyId: string,
  from: string,
  to: string,
): Promise<PeriodPoint[]> {
  const filas = await db
    .select({
      date: rawSql<string>`${transactions.date}::text`,
      type: transactions.type,
      total: rawSql<string>`sum(${transactions.amountBase})`,
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
    .groupBy(transactions.date, transactions.type)
    .orderBy(transactions.date);

  // Se pivota en memoria y no en SQL: son como mucho 366 filas × 4 tipos, y un CROSS
  // JOIN con generate_series para rellenar días vacíos costaría más de lo que ahorra.
  const porDia = new Map<string, PeriodPoint>();
  for (const f of filas) {
    const punto = porDia.get(f.date) ?? { date: f.date, ...VACIO };
    punto[f.type as keyof PeriodTotals] = Number(f.total);
    porDia.set(f.date, punto);
  }
  return [...porDia.values()];
}

/**
 * Primer y último día con movimientos de la empresa, sin filtro de rango. `null` = la
 * empresa no tiene ni una transacción viva.
 *
 * ═══ POR QUÉ EXISTE (CU-868krn2up) ═══
 *
 * Macha reportó "la data solo aparece en Este año; por mes, semana o día no aparece". Las
 * capturas muestran el filtro anual con Q 101.380 y el mensual en Q 0,00 — y el mensual
 * además con un delta en rojo de −100 %.
 *
 * El cálculo estaba bien: los tres filtros pasan por la MISMA consulta sobre el mismo
 * ledger, y no hay camino especial para el año. Lo que pasa es que la contabilidad que subió
 * el cliente no llega hasta el mes en curso. O sea: no había ningún dato que mostrar.
 *
 * Pero la pantalla no decía eso. Decía "Q 0,00" y "−100 %", que es lo que diría un negocio
 * que dejó de vender — y con el número anual justo al lado contradiciéndolo, la lectura
 * inevitable es "el producto está roto". Un cero sin explicación y un bug se ven idénticos,
 * y esa ambigüedad es el defecto de verdad.
 *
 * Con el rango real de los datos, la UI puede decir la única frase que cierra la pregunta:
 * "no hay movimientos en este período; los tuyos van del X al Y".
 *
 * ES BARATO: `transactions_live_date_idx` es exactamente `(company_id, date) WHERE
 * deleted_at IS NULL` (migración 0004), así que min y max son dos saltos a los extremos del
 * índice, no un recorrido. Y va en el mismo `Promise.all` que el resto, así que no agrega
 * latencia de ida y vuelta.
 */
export async function rangoConDatos(
  db: DB,
  companyId: string,
): Promise<{ from: string; to: string } | null> {
  const [fila] = await db
    .select({
      min: rawSql<string | null>`min(${transactions.date})::text`,
      max: rawSql<string | null>`max(${transactions.date})::text`,
    })
    .from(transactions)
    .where(and(eq(transactions.companyId, companyId), isNull(transactions.deletedAt)));

  // Sobre cero filas, `min()` y `max()` devuelven NULL y el `select` devuelve UNA fila con
  // los dos en NULL — no cero filas. Por eso se comprueban los valores y no la longitud.
  if (!fila?.min || !fila.max) return null;
  return { from: fila.min, to: fila.max };
}

export async function computePeriodMetrics(
  db: DB,
  companyId: string,
  from: string,
  to: string,
): Promise<{
  current: PeriodTotals;
  previous: PeriodTotals;
  series: PeriodPoint[];
  dataRange: { from: string; to: string } | null;
}> {
  const previa = ventanaAnterior(from, to);
  const [current, previous, series, dataRange] = await Promise.all([
    totalesPorTipo(db, companyId, from, to),
    totalesPorTipo(db, companyId, previa.from, previa.to),
    seriePorDia(db, companyId, from, to),
    rangoConDatos(db, companyId),
  ]);
  return { current, previous, series, dataRange };
}
