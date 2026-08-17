import { and, eq, isNotNull, isNull, sql as rawSql } from 'drizzle-orm';
import type { DB } from '@/db/client';
import { transactions } from '@/db/schema';

/**
 * Costo unitario DEDUCIDO de lo que la empresa ya vendió, para los SKU cuyo archivo no
 * trae costo.
 *
 * ═══ EL BUG (CU-868kt25ev) ═══
 *
 * Macha reportó el valor de inventario y el costo unitario en **0**. Verificado contra
 * producción, y el patrón dice exactamente dónde está el problema:
 *
 * ```
 * Techstore       54 items · 0 en cero · valor 2 741 022   ✓
 * Electro Hogar   36 items · 0 en cero · valor   666 430   ✓
 * Candelas        42 items · 42 en cero · valor 0          ✗
 * DanielPrueba    42 items · 42 en cero · valor 0          ✗
 * ```
 *
 * No es que la ingesta lea mal el costo: **la hoja `Inventario` de esa plantilla no tiene
 * columna de costo**. Sus columnas son SKU, IDTienda, CantidadDisponible, PuntoReorden,
 * CantidadReorden, FechaÚltimoReabasto, Ubicación, NombreTienda, AlertaReorden — ninguna
 * es un costo. (Está en el corpus de hojas reales, `lib/corpus-hojas-reales.test.ts`.)
 *
 * Pero **el costo SÍ está en el archivo**, en otra hoja: `Ventas` trae `CostoUnitario` por
 * línea, y esa columna ya entra al sistema como movimientos `cogs` ligados al producto.
 * O sea que el dato existe y la pantalla lo estaba ignorando.
 *
 * ═══ CÓMO SE DEDUCE, Y POR QUÉ ASÍ ═══
 *
 * `costo total del producto ÷ unidades vendidas del producto`, que es el **costo promedio
 * ponderado** — el método de valuación más común y el único derivable de lo que hay.
 *
 * Las unidades salen de las filas de INGRESO y no de las de costo, y eso no es un rodeo:
 * hoy las filas `cogs` que la ingesta deriva de una venta **no llevan `quantity`** (medido
 * en producción: 551 filas de costo, 551 con producto, **0 con cantidad**). Las de ingreso
 * de la misma línea sí la llevan, y son las mismas unidades — es la misma venta vista por
 * sus dos caras.
 *
 * Verificado contra el Excel del cliente: `LDC-ACC-0024` deduce 12,56 y el archivo dice
 * `CostoUnitario $12.56`; `LDC-ACC-0019` deduce 6,18 contra `$6.18`. **Coincide al centavo
 * en los 39 SKU que cruzan.**
 *
 * ═══ POR QUÉ AL LEER Y NO AL IMPORTAR ═══
 *
 * Tres razones, y la tercera es la que decide:
 *
 *   1. **Orden.** Al importar, la hoja de inventario puede procesarse antes de que las
 *      ventas estén promovidas; entonces no habría de dónde deducir y el cero volvería.
 *   2. **Arregla lo que YA está cargado.** Las cuatro empresas de producción tienen sus
 *      items escritos con costo 0. Deducir al leer los corrige sin backfill ni resubida.
 *   3. **Procedencia.** `unit_cost_original` + `unit_cost_currency` + `fx_rate` son *lo que
 *      el archivo dijo*, congelado. Escribir ahí un promedio calculado por nosotros borra
 *      la diferencia entre un dato del cliente y una deducción nuestra — y esa diferencia
 *      es justo la que alguien va a querer cuando el número no le cuadre.
 *
 * Por eso el endpoint devuelve además `unitCostIsDerived`: la pantalla puede decir de
 * dónde salió la cifra en vez de presentarla como si viniera del archivo.
 *
 * ═══ CUÁNDO NO APLICA ═══
 *
 * Solo entra si el item tiene costo **0**. Un costo que el archivo sí trajo manda siempre,
 * aunque difiera del promedio: es el dato del cliente. Y un SKU sin ventas no deduce nada
 * y se queda en cero, que es lo correcto — no se puede promediar lo que no se vendió.
 */
export async function costosUnitariosDeducidos(
  db: DB,
  companyId: string,
): Promise<Map<string, number>> {
  /*
   * Una sola consulta agregada, no una por item. El inventario de una empresa son decenas
   * de SKU pero sus movimientos son miles: iterar acá sería el mismo N+1 que CU-868kh8w6b
   * ya tuvo que sacar de `/ar-ap`.
   *
   * `filter (where ...)` de Postgres en vez de dos subconsultas unidas: recorre
   * `transactions` UNA vez y separa costo de unidades en la misma pasada.
   */
  const filas = await db
    .select({
      productId: transactions.productId,
      costo: rawSql<string>`sum(${transactions.amountBase}) filter (where ${transactions.type} = 'cogs')`,
      unidades: rawSql<string>`sum(${transactions.quantity}) filter (where ${transactions.type} = 'revenue')`,
    })
    .from(transactions)
    .where(
      and(
        eq(transactions.companyId, companyId),
        isNull(transactions.deletedAt),
        isNotNull(transactions.productId),
      ),
    )
    .groupBy(transactions.productId);

  const porProducto = new Map<string, number>();
  for (const f of filas) {
    const costo = Number(f.costo);
    const unidades = Number(f.unidades);
    // Las tres guardas son el mismo criterio: sin costo, sin unidades, o con cifras que no
    // son números finitos, NO hay promedio que calcular. Devolver 0 sería indistinguible
    // del cero que este módulo vino a arreglar.
    if (!Number.isFinite(costo) || !Number.isFinite(unidades)) continue;
    if (costo <= 0 || unidades <= 0) continue;
    porProducto.set(f.productId!, costo / unidades);
  }
  return porProducto;
}
