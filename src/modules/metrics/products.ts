import { and, desc, eq, gte, isNull, lte, sql as rawSql } from 'drizzle-orm';
import type { DB } from '@/db/client';
import { transactions, products } from '@/db/schema';

/**
 * Ingresos por producto en un rango — lo que alimenta "Top Product" del dashboard y la
 * pantalla de Product Sales.
 *
 * Solo cuenta `type = 'revenue'`: "producto más vendido" es una pregunta sobre ventas.
 * Incluir costos mezclaría lo que se compró con lo que se vendió y el ranking dejaría de
 * significar nada.
 *
 * Las transacciones SIN producto se excluyen en vez de agruparse en un "Otros". Un
 * documento donde la IA no identificó productos daría una sola barra gigante llamada
 * "Otros" que no le dice nada a nadie; que la lista salga vacía es más honesto y el
 * frontend puede explicar por qué.
 */
export interface ProductRevenue {
  productId: string;
  name: string;
  revenue: number;
  transactionCount: number;
}

export async function revenueByProduct(
  db: DB,
  companyId: string,
  from: string,
  to: string,
  limit = 10,
): Promise<ProductRevenue[]> {
  const filas = await db
    .select({
      productId: products.id,
      name: products.name,
      revenue: rawSql<string>`sum(${transactions.amountBase})`,
      transactionCount: rawSql<string>`count(*)`,
    })
    .from(transactions)
    .innerJoin(
      products,
      and(eq(products.id, transactions.productId), eq(products.companyId, transactions.companyId)),
    )
    .where(
      and(
        eq(transactions.companyId, companyId),
        eq(transactions.type, 'revenue'),
        isNull(transactions.deletedAt),
        gte(transactions.date, from),
        lte(transactions.date, to),
      ),
    )
    .groupBy(products.id, products.name)
    .orderBy(desc(rawSql`sum(${transactions.amountBase})`))
    .limit(limit);

  return filas.map((f) => ({
    productId: f.productId,
    name: f.name,
    revenue: Number(f.revenue),
    transactionCount: Number(f.transactionCount),
  }));
}
