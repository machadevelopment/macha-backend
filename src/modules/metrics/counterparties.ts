import { and, desc, eq, isNull, notInArray, sql as rawSql } from 'drizzle-orm';
import type { DB } from '@/db/client';
import { invoices, bills } from '@/db/schema';
import { AGING_BUCKET_SQL, type AgingBucket } from '@/lib/aging';

/**
 * Concentración de la cartera por CONTRAPARTE — quién le debe a la empresa y a quién le
 * debe ella.
 *
 * ═══ POR QUÉ HACE FALTA (CU-868kt29t0) ═══
 *
 * Los tabs de Cuentas por cobrar y por pagar del prototipo piden dos cosas: la antigüedad
 * (que `GET /ar-ap` ya da) y la **concentración por cliente/proveedor**, que no existía en
 * ningún endpoint. Sin ella el tab solo puede decir "te deben Q X en total", que es un
 * número que el dueño de la PYME ya conoce; lo que no sabe —y es lo accionable— es a quién
 * cobrarle primero.
 *
 * ═══ AGRUPA POSTGRES, NO JAVASCRIPT ═══
 *
 * Es la misma lección que dejó CU-868kh8w6b en `/ar-ap`: aquella versión traía TODAS las
 * facturas abiertas de la empresa y las agrupaba en el servidor de Node, o sea
 * transferencia y memoria proporcionales al tamaño de la cartera para devolver diez
 * números. Acá el `group by` y el `limit` van en la consulta desde el principio.
 *
 * ═══ EL LÍMITE, Y POR QUÉ VIENE CON UN RESTO ═══
 *
 * Se devuelven las N contrapartes más grandes MÁS un renglón `resto` con lo demás
 * agregado. Sin el resto, la interfaz solo puede mostrar un top que no suma al total de
 * `/ar-ap`, y dos cifras que no cuadran en la misma pantalla se leen como un error de
 * cálculo — aunque las dos estén bien. Con el resto, la suma cierra.
 *
 * ═══ `overdue` SE CALCULA ACÁ Y NO SE DERIVA ═══
 *
 * Es la parte vencida de lo que esa contraparte debe, con el MISMO criterio de
 * `AGING_BUCKET_SQL` (`due_date < current_date`), no una resta de los baldes. Derivarla en
 * el cliente obligaría a mandar los cinco baldes por contraparte, y el único uso real es
 * "cuánto de esto ya se pasó de fecha".
 *
 * `due_date IS NULL` cuenta como AL DÍA, igual que en el aging: una factura sin fecha de
 * vencimiento no está vencida — no se sabe cuándo vence. Tratarla como vencida inflaría la
 * mora con documentos que el propio Excel del cliente trajo sin fecha.
 */

export interface CounterpartyRow {
  counterparty: string;
  total: number;
  overdue: number;
  invoiceCount: number;
  /** Balde de la parte MÁS vieja: es lo que decide el color del renglón en la interfaz. */
  worstBucket: AgingBucket;
}

export interface CounterpartyConcentration {
  top: CounterpartyRow[];
  /** Todo lo que no entró en `top`, agregado. Cero si la cartera cabe entera en el tope. */
  resto: { total: number; counterpartyCount: number };
}

/** Orden de gravedad de los baldes, para elegir el peor de una contraparte. */
const GRAVEDAD: Record<AgingBucket, number> = {
  current: 0,
  '1_30': 1,
  '31_60': 2,
  '61_90': 3,
  '90_plus': 4,
};

const VENCIDO_SQL = rawSql`case when due_date is not null and due_date < current_date
  then amount_base else 0 end`;

type Tabla = typeof invoices | typeof bills;

async function concentracion(
  db: DB,
  tabla: Tabla,
  companyId: string,
  limit: number,
): Promise<CounterpartyConcentration> {
  const filas = await db
    .select({
      counterparty: tabla.counterparty,
      total: rawSql<string>`sum(amount_base)`,
      overdue: rawSql<string>`sum(${VENCIDO_SQL})`,
      invoiceCount: rawSql<string>`count(*)`,
      // El balde más grave de esta contraparte. `max` sobre el texto NO serviría —
      // alfabéticamente '90_plus' va después de '1_30' pero antes de 'current'—, así que se
      // traen todos los presentes y se elige por gravedad abajo, con el orden explícito.
      buckets: rawSql<AgingBucket[]>`array_agg(distinct ${AGING_BUCKET_SQL})`,
    })
    .from(tabla)
    .where(and(eq(tabla.companyId, companyId), eq(tabla.status, 'open'), isNull(tabla.deletedAt)))
    .groupBy(tabla.counterparty)
    .orderBy(desc(rawSql`sum(amount_base)`))
    // +1 para saber si hay resto sin una segunda consulta de conteo. Mismo patrón
    // "limit + 1" que la paginación de `/reports` y `/admin/staging-rows`.
    .limit(limit + 1);

  const top = filas.slice(0, limit).map((f) => ({
    counterparty: f.counterparty,
    total: Number(f.total),
    overdue: Number(f.overdue),
    invoiceCount: Number(f.invoiceCount),
    worstBucket: [...f.buckets].sort((a, b) => GRAVEDAD[b] - GRAVEDAD[a])[0] ?? 'current',
  }));

  if (filas.length <= limit) return { top, resto: { total: 0, counterpartyCount: 0 } };

  /*
   * El resto se consulta aparte en vez de sumarse desde las filas que ya se trajeron: para
   * eso habría que traerlas TODAS, que es precisamente lo que el `limit` evita. Es una
   * segunda agregación sobre el mismo índice y solo corre cuando de verdad hay resto.
   *
   * `NOT IN` sobre los nombres del top y no un `OFFSET`: con `offset` el resultado dependería
   * de que el orden sea estable entre las dos consultas, y dos contrapartes con el mismo
   * total no lo garantizan — una podría contarse dos veces o ninguna.
   *
   * Con `notInArray` y no con un `<> all(...)` a mano: aquella versión pasaba el arreglo de
   * JavaScript como un parámetro suelto y Postgres lo rechazaba con `op ANY/ALL (array)
   * requires array on right side`. El helper de Drizzle expande la lista, así que no hay
   * casteo que recordar. La lista nunca está vacía acá — solo se llega si `limit >= 1` y
   * hubo más filas que el tope.
   */
  const nombresDelTop = top.map((f) => f.counterparty);
  const [resto] = await db
    .select({
      total: rawSql<string>`coalesce(sum(amount_base), 0)`,
      counterpartyCount: rawSql<string>`count(distinct ${tabla.counterparty})`,
    })
    .from(tabla)
    .where(
      and(
        eq(tabla.companyId, companyId),
        eq(tabla.status, 'open'),
        isNull(tabla.deletedAt),
        notInArray(tabla.counterparty, nombresDelTop),
      ),
    );

  return {
    top,
    resto: {
      total: Number(resto?.total ?? 0),
      counterpartyCount: Number(resto?.counterpartyCount ?? 0),
    },
  };
}

/** Tope duro. Ver la nota de arriba: el resto agregado es lo que hace que la suma cierre. */
export const MAX_CONTRAPARTES = 50;

export async function counterpartyConcentration(
  db: DB,
  companyId: string,
  limit: number,
): Promise<{ ar: CounterpartyConcentration; ap: CounterpartyConcentration }> {
  const tope = Math.min(Math.max(limit, 1), MAX_CONTRAPARTES);
  const [ar, ap] = await Promise.all([
    concentracion(db, invoices, companyId, tope),
    concentracion(db, bills, companyId, tope),
  ]);
  return { ar, ap };
}
