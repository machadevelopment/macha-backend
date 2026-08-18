import { and, eq, gte, isNull, lte, sql as rawSql } from 'drizzle-orm';
import type { DB } from '@/db/client';
import { transactions, products } from '@/db/schema';
import { grossProfit, grossMarginPct } from '@/lib/margin';
import { ventanaAnterior } from './period';

/**
 * Desempeño por producto en un rango — alimenta "Top Product" del dashboard y la pantalla
 * completa de Ventas por producto.
 *
 * INGRESO Y COSTO SE PIDEN EN LA MISMA CONSULTA, no en dos. La versión anterior filtraba
 * `type = 'revenue'` y devolvía solo ingreso: bastaba para rankear "más vendido", pero la
 * pantalla necesita además el costo para el margen, y traerlo aparte obligaría a una
 * segunda query y a casar dos listas de productos que no coinciden (hay productos que se
 * compraron y no se vendieron). Se agrega por producto de una vez y se separa por `type`
 * con FILTER.
 *
 * El margen usa `lib/margin.ts`, la MISMA definición cerrada que el KPI del dashboard, el
 * reporte y la alerta (PRD §Margen, decisión de Jose CU-868kh8y58): utilidad bruta =
 * ingreso − costo directo, sin restar gasto operativo. Recalcularlo aquí a mano era la
 * forma segura de que la pantalla de productos mostrara un margen distinto al del
 * panorama para los mismos datos.
 *
 * Las transacciones SIN producto se excluyen en vez de agruparse en un "Otros". Un
 * documento donde la IA no identificó productos daría una sola barra gigante llamada
 * "Otros" que no le dice nada a nadie; que la lista salga vacía es más honesto y el
 * frontend puede explicar por qué.
 */
export interface ProductPerformance {
  productId: string;
  name: string;
  /** Familia comercial; `null` mientras la ingesta no la haya podido deducir. */
  category: string | null;
  revenue: number;
  cogs: number;
  grossProfit: number;
  /** `null` en un producto sin ventas en el rango — dividir entre cero no es 0%. */
  grossMarginPct: number | null;
  /**
   * Unidades vendidas, o `null` si NINGUNA fila de venta de este producto trajo cantidad.
   *
   * El null importa y no es lo mismo que 0: `transactions.quantity` es nullable porque
   * muchos libros no traen una columna de unidades. Un 0 diría "se vendieron cero" sobre
   * un producto que facturó miles.
   */
  units: number | null;
  /**
   * Ingreso SOLO de las filas que traen unidades. Es el denominador honesto del ticket
   * promedio: dividir el ingreso total entre las unidades de un subconjunto de filas
   * inventa un ticket más alto mientras más incompleto venga el archivo.
   */
  revenueWithUnits: number;
  transactionCount: number;
  /** Participación en el ingreso total de productos del rango. */
  revenueSharePct: number;
  /** Ingreso del mismo producto en la ventana anterior de igual duración. */
  previousRevenue: number;
  trend: 'up' | 'down' | 'flat';
  /**
   * ¿Este producto tiene costo cargado en el rango? — CU-868ktm9gw.
   *
   * `cogs` se agrega con `coalesce(..., 0)`, así que un producto al que nunca se le
   * cargó una fila de costo es indistinguible, en el número, de uno que costó cero: los
   * dos salen con `grossMarginPct === 100`. Para la pantalla eso nunca importó porque
   * ordena por INGRESO y el 100 % queda perdido entre otras columnas; para cualquier
   * pregunta de la forma "¿cuál deja más margen?" es determinante, porque ese 100 %
   * gana el ranking siempre y la respuesta pasa a ser el producto peor documentado.
   *
   * No se filtra aquí: se DECLARA, y quien ordene por margen decide. Descartarlos en
   * silencio escondería justo lo que hay que decirle al dueño — que a ese producto le
   * falta el costo.
   */
  costKnown: boolean;
}

/**
 * Criterio de orden. `revenue` es el de siempre y sigue siendo el de la pantalla; los
 * otros dos existen porque el asesor recibe preguntas que no son "cuál vendió más".
 */
export type ProductOrderBy = 'revenue' | 'margin' | 'units';

/** Suma agregada por producto en un rango, sin post-proceso. */
async function agregarPorProducto(
  db: DB,
  companyId: string,
  from: string,
  to: string,
): Promise<
  Map<
    string,
    {
      name: string;
      category: string | null;
      revenue: number;
      cogs: number;
      units: number | null;
      revenueWithUnits: number;
      transactionCount: number;
    }
  >
> {
  const filas = await db
    .select({
      productId: products.id,
      name: products.name,
      category: products.category,
      revenue: rawSql<string>`coalesce(sum(${transactions.amountBase}) filter (where ${transactions.type} = 'revenue'), 0)`,
      cogs: rawSql<string>`coalesce(sum(${transactions.amountBase}) filter (where ${transactions.type} = 'cogs'), 0)`,
      // Sin coalesce: si ninguna fila de venta trae cantidad, sum() es NULL y ese NULL
      // es justo el dato ("este archivo no dice unidades"). Un coalesce a 0 lo perdería.
      units: rawSql<
        string | null
      >`sum(${transactions.quantity}) filter (where ${transactions.type} = 'revenue' and ${transactions.quantity} is not null)`,
      revenueWithUnits: rawSql<string>`coalesce(sum(${transactions.amountBase}) filter (where ${transactions.type} = 'revenue' and ${transactions.quantity} is not null), 0)`,
      transactionCount: rawSql<string>`count(*) filter (where ${transactions.type} = 'revenue')`,
    })
    .from(transactions)
    .innerJoin(
      products,
      and(eq(products.id, transactions.productId), eq(products.companyId, transactions.companyId)),
    )
    .where(
      and(
        eq(transactions.companyId, companyId),
        isNull(transactions.deletedAt),
        gte(transactions.date, from),
        lte(transactions.date, to),
      ),
    )
    .groupBy(products.id, products.name, products.category);

  return new Map(
    filas.map((f) => [
      f.productId,
      {
        name: f.name,
        category: f.category,
        revenue: Number(f.revenue),
        cogs: Number(f.cogs),
        units: f.units === null ? null : Number(f.units),
        revenueWithUnits: Number(f.revenueWithUnits),
        transactionCount: Number(f.transactionCount),
      },
    ]),
  );
}

/**
 * Umbral bajo el cual un cambio de ingreso se considera plano.
 *
 * Sin él, un producto que pasó de 10.000,00 a 10.000,01 saldría con flecha de subida
 * verde. La pantalla usa ese ícono para decidir qué mirar; una flecha por medio centavo
 * lo vuelve ruido y entrena a ignorarlo.
 */
const UMBRAL_TENDENCIA_PCT = 1;

function tendencia(actual: number, previo: number): 'up' | 'down' | 'flat' {
  // Producto nuevo (no existía en la ventana anterior): sube si vendió algo. Calcular el
  // porcentaje contra 0 daría infinito.
  if (previo === 0) return actual > 0 ? 'up' : 'flat';
  const cambio = ((actual - previo) / previo) * 100;
  if (Math.abs(cambio) < UMBRAL_TENDENCIA_PCT) return 'flat';
  return cambio > 0 ? 'up' : 'down';
}

/**
 * Ordena la lista completa antes de recortarla — CU-868ktm9gw.
 *
 * EL RECORTE ES LO QUE HACE QUE EL ORDEN IMPORTE. Con `limit` sobre una lista ordenada
 * por ingreso, preguntar "¿cuál deja más margen?" se responde sobre los diez que más
 * VENDIERON, no sobre el catálogo. Eso fue el reporte: el asesor contestó 20,2 % y
 * existía un producto al 42,6 % — ninguno de los dos números estaba mal calculado, la
 * pregunta se había respondido sobre el conjunto equivocado.
 *
 * Por margen, los productos SIN COSTO CARGADO van al final aunque su porcentaje sea el
 * más alto: su 100 % es un dato que falta, no una ganancia. Y los de `grossMarginPct`
 * nulo (comprados pero no vendidos en el rango) también, por lo mismo — no tienen
 * margen, no tienen margen del 0 %.
 */
function ordenar(items: ProductPerformance[], orderBy: ProductOrderBy): ProductPerformance[] {
  if (orderBy === 'revenue') return items.sort((a, b) => b.revenue - a.revenue);

  if (orderBy === 'units') {
    // `units` nulo significa "el archivo no dice unidades", no "vendió cero": al final,
    // porque no se pueden comparar contra un número.
    return items.sort((a, b) => (b.units ?? -1) - (a.units ?? -1));
  }

  return items.sort((a, b) => {
    const rankeable = (p: ProductPerformance): boolean => p.costKnown && p.grossMarginPct !== null;
    if (rankeable(a) !== rankeable(b)) return rankeable(a) ? -1 : 1;
    // Entre los no rankeables el orden es por ingreso, para que la cola quede en algún
    // orden útil en vez de en el que vino de la base.
    if (!rankeable(a)) return b.revenue - a.revenue;
    return b.grossMarginPct! - a.grossMarginPct!;
  });
}

export async function productPerformance(
  db: DB,
  companyId: string,
  from: string,
  to: string,
  limit = 10,
  orderBy: ProductOrderBy = 'revenue',
): Promise<ProductPerformance[]> {
  const previa = ventanaAnterior(from, to);
  const [actual, anterior] = await Promise.all([
    agregarPorProducto(db, companyId, from, to),
    agregarPorProducto(db, companyId, previa.from, previa.to),
  ]);

  // La participación se calcula sobre el ingreso de TODOS los productos del rango, no
  // sobre los que sobreviven al `limit`. Si no, los porcentajes de una lista recortada
  // sumarían 100% y dirían que el top 5 es el negocio entero.
  const ingresoTotal = [...actual.values()].reduce((s, p) => s + p.revenue, 0);

  const items = [...actual.entries()].map(([productId, p]) => {
    const previousRevenue = anterior.get(productId)?.revenue ?? 0;
    return {
      productId,
      name: p.name,
      category: p.category,
      revenue: p.revenue,
      cogs: p.cogs,
      grossProfit: grossProfit(p.revenue, p.cogs),
      grossMarginPct: grossMarginPct(p.revenue, p.cogs),
      units: p.units,
      revenueWithUnits: p.revenueWithUnits,
      transactionCount: p.transactionCount,
      revenueSharePct: ingresoTotal === 0 ? 0 : (p.revenue / ingresoTotal) * 100,
      previousRevenue,
      trend: tendencia(p.revenue, previousRevenue),
      costKnown: p.cogs > 0,
    };
  });

  return ordenar(items, orderBy).slice(0, limit);
}
