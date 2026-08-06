import { and, eq, gte, isNull, lte, sql as rawSql } from 'drizzle-orm';
import type { DB } from '@/db/client';
import { transactions } from '@/db/schema';

/**
 * Desglose por categoría contable en un rango — el "Cost Breakdown by Category" de la
 * pantalla de Analítica.
 *
 * Es `transactions.category`, la etiqueta que la IA le pone al MOVIMIENTO (alquiler,
 * planilla, materia prima), y no `products.category`, que es la familia comercial del
 * producto. Se parecen en el nombre y responden preguntas distintas: esta contesta "en qué
 * se va el dinero", la otra "qué se vende". La pantalla de Ventas por producto usa la
 * segunda y la arma agrupando la lista de productos, sin pedir otro endpoint.
 *
 * Se devuelve el `type` junto a la categoría porque la misma etiqueta puede aparecer en
 * dos tipos —"transporte" puede ser costo directo de un envío y gasto operativo de la
 * camioneta del gerente— y colapsarlas escondería justo la distinción que sostiene la
 * definición de margen bruto del PRD.
 */
export interface CategoryBreakdownRow {
  category: string;
  type: 'revenue' | 'cogs' | 'opex' | 'other';
  total: number;
  transactionCount: number;
  /** Participación dentro de su propio `type`, no del total general. Ver nota abajo. */
  sharePct: number;
}

export async function categoryBreakdown(
  db: DB,
  companyId: string,
  from: string,
  to: string,
): Promise<CategoryBreakdownRow[]> {
  const filas = await db
    .select({
      category: transactions.category,
      type: transactions.type,
      total: rawSql<string>`sum(${transactions.amountBase})`,
      transactionCount: rawSql<string>`count(*)`,
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
    .groupBy(transactions.category, transactions.type)
    .orderBy(rawSql`sum(${transactions.amountBase}) desc`);

  // La participación es dentro del mismo `type` y no sobre el total general, porque el
  // total general mezcla ingreso con costo: una categoría de gasto que valga "el 12% de
  // todo" no significa nada cuando ese "todo" incluye las ventas. Dentro de `opex`, en
  // cambio, 12% sí se lee como "una octava parte de lo que gasto".
  const totalPorTipo = new Map<string, number>();
  for (const f of filas) {
    totalPorTipo.set(f.type, (totalPorTipo.get(f.type) ?? 0) + Number(f.total));
  }

  return filas.map((f) => {
    const total = Number(f.total);
    const totalTipo = totalPorTipo.get(f.type) ?? 0;
    return {
      category: f.category,
      type: f.type as CategoryBreakdownRow['type'],
      total,
      transactionCount: Number(f.transactionCount),
      sharePct: totalTipo === 0 ? 0 : (total / totalTipo) * 100,
    };
  });
}
