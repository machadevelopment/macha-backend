import { and, eq, gte, isNull, lte, sql as rawSql } from 'drizzle-orm';
import type { DB } from '@/db/client';
import { stores, transactions } from '@/db/schema';

/**
 * Ventas por TIENDA en un rango — la tarjeta de "Ventas por tienda" (CU-868kuw1e3, pedido
 * de Jose) y la herramienta `sales_by_store` del asesor (CU-868kt8kk9).
 *
 * ═══ UNA SOLA DEFINICIÓN, PORQUE YA HABÍA DOS ESPERANDO A SEPARARSE ═══
 *
 * Esta agregación ya existía escrita a mano dentro de `chat-tools.ts`. Duplicarla acá para
 * la tarjeta habría dejado dos "ventas por tienda" en el producto, y el día que una cambie
 * —que se decida incluir `other`, o excluir un tipo, o cambiar el manejo de las filas sin
 * tienda— el asesor y la pantalla le darían al MISMO dueño dos cifras distintas para la
 * misma pregunta, sin que nada falle. Es el mismo motivo por el que `gastos()` vive en un
 * solo lado para el Dashboard y para Analítica.
 *
 * ═══ SOLO `revenue`, Y ESO ES LA PREGUNTA, NO UN FILTRO ═══
 *
 * "Ventas por tienda" pregunta cuánto VENDIÓ cada local. Meter `cogs` u `opex` acá
 * respondería otra cosa (cuánto se movió por local) y en un donut de participación daría
 * porcentajes que no significan nada: sumar lo que entra con lo que sale.
 *
 * ═══ LAS FILAS SIN TIENDA SE CUENTAN APARTE, NO SE TIRAN NI SE MEZCLAN ═══
 *
 * `store_id` es opcional y la mayoría de los Excel de una PYME no traen columna de tienda,
 * así que lo normal es que una empresa tenga ventas con tienda y ventas sin ella. Las dos
 * salidas fáciles son malas:
 *
 *   · agruparlas bajo una etiqueta inventada ("Sin tienda") pone al desconocido a competir
 *     por el primer puesto del ranking;
 *   · tirarlas y calcular la participación sobre lo que queda produce un donut que suma
 *     100 % sobre una parte de las ventas, sin decirlo — el dueño lee "Tienda A: 60 %" de
 *     TODO cuando es el 60 % de la mitad que sí tenía tienda.
 *
 * Por eso van en `unattributedTotal`, fuera de las filas: la participación se calcula sobre
 * lo ATRIBUIDO (que es lo único de lo que se puede afirmar algo) y quien pinte la tarjeta
 * tiene el número que le falta para decirlo en voz alta.
 *
 * El `leftJoin` es lo que permite traer las dos cosas en una pasada. Lleva `companyId` en
 * la condición además del id: el FK de `transactions.store_id` es compuesto
 * `(company_id, store_id)` justamente para que una tienda de otra empresa no se pueda
 * referenciar, y la consulta no tiene por qué ser más laxa que el esquema.
 */
export interface StoreBreakdownRow {
  storeId: string;
  name: string;
  total: number;
  transactionCount: number;
  /** Participación sobre las ventas CON tienda, no sobre las ventas del período. */
  sharePct: number;
}

export interface StoreBreakdown {
  rows: StoreBreakdownRow[];
  /** Ventas del período sin `store_id`. Cero no es lo mismo que no haber tiendas. */
  unattributedTotal: number;
}

export async function storeBreakdown(
  db: DB,
  companyId: string,
  from?: string,
  to?: string,
): Promise<StoreBreakdown> {
  const condiciones = [
    eq(transactions.companyId, companyId),
    isNull(transactions.deletedAt),
    eq(transactions.type, 'revenue'),
  ];
  if (from) condiciones.push(gte(transactions.date, from));
  if (to) condiciones.push(lte(transactions.date, to));

  const filas = await db
    .select({
      storeId: transactions.storeId,
      name: stores.name,
      total: rawSql<string>`sum(${transactions.amountBase})`,
      transactionCount: rawSql<string>`count(*)`,
    })
    .from(transactions)
    .leftJoin(
      stores,
      and(eq(stores.id, transactions.storeId), eq(stores.companyId, transactions.companyId)),
    )
    .where(and(...condiciones))
    .groupBy(transactions.storeId, stores.name)
    .orderBy(rawSql`sum(${transactions.amountBase}) desc`);

  let unattributedTotal = 0;
  const conTienda: { storeId: string; name: string; total: number; transactionCount: number }[] =
    [];

  for (const f of filas) {
    const total = Number(f.total);
    // `storeId` nulo es la fila sin tienda. `name` nulo con `storeId` presente no puede
    // pasar: el FK compuesto lo impide. Si pasara, la fila iría al balde sin atribuir en vez
    // de pintarse con un nombre vacío.
    if (f.storeId === null || f.name === null) {
      unattributedTotal += total;
      continue;
    }
    conTienda.push({
      storeId: f.storeId,
      name: f.name,
      total,
      transactionCount: Number(f.transactionCount),
    });
  }

  const totalAtribuido = conTienda.reduce((acc, f) => acc + f.total, 0);

  return {
    rows: conTienda.map((f) => ({
      ...f,
      sharePct: totalAtribuido === 0 ? 0 : (f.total / totalAtribuido) * 100,
    })),
    unattributedTotal,
  };
}
