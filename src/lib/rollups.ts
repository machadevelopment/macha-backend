import { and, eq, inArray, isNull, sql as rawSql } from 'drizzle-orm';
import type { DB } from '@/db/client';
import { metricRollups, transactions } from '@/db/schema';

export type RollupType = 'revenue' | 'cogs' | 'opex' | 'other';
export const ROLLUP_TYPES: RollupType[] = ['revenue', 'cogs', 'opex', 'other'];

/**
 * CU-868kfvab1: cache-aside dashboard rollups (data model.md §4.15). Only
 * `granularity='month'`, `category=NULL` (per-type monthly totals) is populated in
 * v1 — enough for the fixed KPIs (ingresos/costos/margen). Quarter/year granularity
 * and per-category rollups are the same shape but unused until a ticket needs them.
 *
 * NOTE on upsert: `metric_rollups_uq` is UNIQUE(company_id, granularity, period,
 * type, category), but `category` is nullable and SQL NULLs are never equal to each
 * other in a unique check — `ON CONFLICT` on that index would never match our
 * category=NULL rows and would insert duplicates instead of updating. So this uses
 * explicit select-then-update-or-insert instead of `onConflictDoUpdate`.
 */
async function sumTransactionsForMonth(
  db: DB,
  companyId: string,
  period: string,
  type: RollupType,
): Promise<number> {
  const [row] = await db
    .select({ total: rawSql<string>`coalesce(sum(${transactions.amountBase}), 0)` })
    .from(transactions)
    .where(
      and(
        eq(transactions.companyId, companyId),
        eq(transactions.type, type),
        isNull(transactions.deletedAt),
        rawSql`date_trunc('month', ${transactions.date}) = ${period}::date`,
      ),
    );
  return Number(row?.total ?? 0);
}

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA ESCRITURA DEL CACHÉ NUNCA PUEDE HACER ESPERAR A UNA LECTURA (caída del 2026-08-26)
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *
 * `metric_rollups` es un CACHÉ, y su clave única `(empresa, mes, tipo)` es LA MISMA para todas
 * las cargas de dashboard de una empresa. Eso convirtió una transacción colgada en la caída
 * del producto entero:
 *
 *     pid 315 · transacción abierta 57 min, con su insert de rollup sin commitear
 *     9 sesiones encoladas: insert into "metric_rollups" (...)
 *     macha_app: 10 de 10 conexiones → todo lo que toca la base falla
 *
 * `onConflictDoNothing` NO evita esto y es la parte que sorprende: ante una clave duplicada
 * Postgres hace ESPERAR al segundo insert hasta saber si el primero commitea o aborta. La
 * cláusula resuelve el conflicto, no la espera.
 *
 * ═══ EL LOCK CONSULTIVO, Y POR QUÉ ES LA HERRAMIENTA CORRECTA ═══
 *
 * `pg_try_advisory_xact_lock` no espera: devuelve `false` en el acto si otro lo tiene. Así que
 * cuando dos lectores concurrentes quieren llenar el mismo caché, uno escribe y el resto se lo
 * saltan **sin tocar la clave única**, o sea sin poder encolarse detrás de nadie.
 *
 * Con la transacción colgada de la caída: ella tendría el lock, y las otras nueve lo verían
 * ocupado y seguirían de largo. Ninguna se habría bloqueado y el pool nunca se habría agotado.
 *
 * ═══ PERDER LA ESCRITURA ES INOFENSIVO, Y YA ESTABA ASUMIDO ═══
 *
 * El comentario de `onConflictDoNothing` más abajo ya lo dice: quien gana calcula sobre EL
 * MISMO ledger y escribe el mismo número. Saltarse el caché no devuelve un dato peor — el
 * valor se calculó igual y se devuelve igual; lo único que se pierde es tenerlo guardado, y la
 * siguiente lectura lo vuelve a intentar. La degradación es "más lento", nunca "mal".
 *
 * ⚠️ Es por EMPRESA y no por fila a propósito: una empresa escribe sus doce meses en un solo
 * insert, así que un lock por fila multiplicaría las llamadas sin cambiar el resultado.
 *
 * ⚠️ Y NO se aplica al camino de promoción (`refreshExistingRollups`): ese corre en el worker,
 * no compite con lecturas y debe escribir siempre.
 */
async function cachePropio(db: DB, companyId: string): Promise<boolean> {
  // `_xact_`: se libera solo al cerrar la transacción, así que no hay nada que desbloquear a
  // mano ni forma de olvidarse — que es justo el error que causó la caída.
  const filas = await db.execute<{ tomado: boolean }>(
    rawSql`select pg_try_advisory_xact_lock(hashtext(${'rollup:' + companyId})::bigint) as tomado`,
  );
  const fila = (filas as unknown as { tomado: boolean }[])[0];
  return fila?.tomado === true;
}

async function upsertMonthlyRollup(
  db: DB,
  companyId: string,
  period: string,
  type: RollupType,
  amountBase: number,
): Promise<void> {
  const [existing] = await db
    .select({ id: metricRollups.id })
    .from(metricRollups)
    .where(
      and(
        eq(metricRollups.companyId, companyId),
        eq(metricRollups.granularity, 'month'),
        eq(metricRollups.period, period),
        eq(metricRollups.type, type),
        isNull(metricRollups.category),
      ),
    );

  if (existing) {
    await db
      .update(metricRollups)
      .set({ amountBase: String(amountBase), computedAt: new Date() })
      .where(eq(metricRollups.id, existing.id));
  } else {
    /*
     * Misma ventana que en la versión por lotes: entre el SELECT de arriba y este INSERT otro
     * proceso pudo crear la fila. `onConflictDoNothing` la absorbe en vez de tumbar la
     * promoción entera por un rollup — que es un caché, no contabilidad.
     */
    // Ver `cachePropio`: si otro lector ya está llenando este caché, no se escribe. Encolarse
    // detrás de su lock es lo que tumbó producción.
    if (!(await cachePropio(db, companyId))) return;
    await db
      .insert(metricRollups)
      .values({
        companyId,
        granularity: 'month',
        period,
        type,
        category: null,
        amountBase: String(amountBase),
      })
      .onConflictDoNothing();
  }
}

/** First-access lazy fill (criterio 2): compute+store if missing, else return the cached value untouched. */
export async function getOrComputeMonthlyAmount(
  db: DB,
  companyId: string,
  period: string,
  type: RollupType,
): Promise<number> {
  const [existing] = await db
    .select({ amountBase: metricRollups.amountBase })
    .from(metricRollups)
    .where(
      and(
        eq(metricRollups.companyId, companyId),
        eq(metricRollups.granularity, 'month'),
        eq(metricRollups.period, period),
        eq(metricRollups.type, type),
        isNull(metricRollups.category),
      ),
    );
  if (existing) return Number(existing.amountBase);

  const amount = await sumTransactionsForMonth(db, companyId, period, type);
  await upsertMonthlyRollup(db, companyId, period, type, amount);
  return amount;
}

/**
 * Versión por lotes de `getOrComputeMonthlyAmount` — CU-868kh8w6b.
 *
 * `/metrics` recorría `periods × ROLLUP_TYPES` llamando a la versión de una en una:
 * 48 round-trips secuenciales con el default de 12 meses, y 144 con `months=36` (el
 * máximo que acepta el schema). Aquí son **2 queries** pase lo que pase: una lee los
 * rollups cacheados de todos los períodos, y otra agrega las transacciones de los que
 * falten, agrupando por período y tipo.
 *
 * **La semántica de cache-aside se preserva exactamente**, que es el riesgo que
 * señalaba el ticket: un (período, tipo) ya cacheado se devuelve tal cual sin
 * recalcularse, y uno nunca visto se calcula Y SE PERSISTE — incluido cuando el total
 * es 0, igual que hacía `sumTransactionsForMonth` + `upsertMonthlyRollup`. Si un
 * período con cero movimiento no se persistiera, se recalcularía en cada request para
 * siempre.
 *
 * Devuelve un mapa `período → { revenue, cogs, opex, other }` con todos los períodos
 * pedidos y los 4 tipos siempre presentes.
 */
export async function getOrComputeMonthlyAmounts(
  db: DB,
  companyId: string,
  periods: string[],
  types: RollupType[] = ROLLUP_TYPES,
): Promise<Map<string, Record<RollupType, number>>> {
  const result = new Map<string, Record<RollupType, number>>();
  for (const period of periods) {
    result.set(period, { revenue: 0, cogs: 0, opex: 0, other: 0 });
  }
  if (periods.length === 0) return result;

  // 1 query: todo lo que ya está cacheado, para los períodos pedidos.
  const cached = await db
    .select({
      period: metricRollups.period,
      type: metricRollups.type,
      amountBase: metricRollups.amountBase,
    })
    .from(metricRollups)
    .where(
      and(
        eq(metricRollups.companyId, companyId),
        eq(metricRollups.granularity, 'month'),
        isNull(metricRollups.category),
        inArray(metricRollups.period, periods),
      ),
    );

  const seen = new Set<string>();
  for (const row of cached) {
    if (!row.type || !result.has(row.period)) continue;
    const bucket = result.get(row.period)!;
    const type = row.type as RollupType;
    if (!types.includes(type)) continue;
    bucket[type] = Number(row.amountBase);
    seen.add(`${row.period}|${type}`);
  }

  const missing = periods.flatMap((period) =>
    types.filter((type) => !seen.has(`${period}|${type}`)).map((type) => ({ period, type })),
  );
  if (missing.length === 0) return result;

  // 1 query: suma agregada de las transacciones de TODOS los períodos faltantes de una
  // vez, agrupando por mes y tipo — en vez de un SELECT por combinación.
  const missingPeriods = [...new Set(missing.map((m) => m.period))];
  const missingTypes = [...new Set(missing.map((m) => m.type))];
  const sums = await db
    .select({
      period: rawSql<string>`to_char(date_trunc('month', ${transactions.date}), 'YYYY-MM-DD')`.as(
        'period',
      ),
      type: transactions.type,
      total: rawSql<string>`coalesce(sum(${transactions.amountBase}), 0)`,
    })
    .from(transactions)
    .where(
      and(
        eq(transactions.companyId, companyId),
        isNull(transactions.deletedAt),
        inArray(transactions.type, missingTypes),
        // `inArray` sobre la expresión (y no `= any(array)`): Drizzle interpola un
        // array de JS como lista de parámetros, no como literal de array de Postgres.
        inArray(rawSql`date_trunc('month', ${transactions.date})::date`, missingPeriods),
      ),
    )
    .groupBy(rawSql`date_trunc('month', ${transactions.date})`, transactions.type);

  const computed = new Map<string, number>();
  for (const row of sums) {
    computed.set(`${row.period}|${row.type}`, Number(row.total));
  }

  // Persistimos TODOS los faltantes, también los que suman 0: es lo que hacía el
  // camino de una-en-una, y sin ello un mes sin movimiento nunca se cachearía.
  const toInsert = missing.map(({ period, type }) => ({
    companyId,
    granularity: 'month' as const,
    period,
    type,
    category: null,
    amountBase: String(computed.get(`${period}|${type}`) ?? 0),
  }));
  /*
   * `onConflictDoNothing` y no un insert a secas — bug reportado por Jose (2026-08-14).
   *
   * Entre el SELECT de arriba y este INSERT hay una ventana, y dos dashboards abiertos a la
   * vez la atraviesan juntos: los dos ven el caché vacío, los dos calculan, los dos insertan.
   *
   * Hasta la migración 0029 eso no fallaba y era MUCHO peor que fallar: `metric_rollups_uq`
   * incluye `category`, que es NULL en todas estas filas, y en Postgres NULL no colisiona en
   * un índice único. Los dos INSERT entraban y la empresa se quedaba con filas duplicadas del
   * mismo período — a partir de ahí cada lectura devolvía la que Postgres diera primero y dos
   * usuarios veían cifras distintas.
   *
   * Con el índice parcial de 0029 la colisión ya es real, así que hay que absorberla. Perder
   * este insert es inofensivo: el que ganó calculó sobre EL MISMO ledger y escribió el mismo
   * número.
   */
  // Ver `cachePropio`. Va DESPUÉS de calcular y ANTES de escribir: el valor que se devuelve
  // no depende de haber ganado el lock, solo el guardarlo.
  if (await cachePropio(db, companyId)) {
    await db.insert(metricRollups).values(toInsert).onConflictDoNothing();
  }

  for (const { period, type } of missing) {
    result.get(period)![type] = computed.get(`${period}|${type}`) ?? 0;
  }
  return result;
}

/**
 * Ingestion-completion hook (criterio 1/2): recompute only rollups that already
 * exist for this company ("previously seen" — never-seen ones stay lazy, filled at
 * first /metrics read). Called after a successful promotion in the excel-ingest
 * worker.
 */
export async function refreshExistingRollups(db: DB, companyId: string): Promise<void> {
  const existing = await db
    .select({ period: metricRollups.period, type: metricRollups.type })
    .from(metricRollups)
    .where(
      and(
        eq(metricRollups.companyId, companyId),
        eq(metricRollups.granularity, 'month'),
        isNull(metricRollups.category),
      ),
    );

  if (existing.length === 0) return;

  // CU-868kh8w6b: antes era un SELECT+UPDATE por cada (período, tipo) ya cacheado, en
  // serie, dentro del worker de ingesta — el mismo N+1 que /metrics, y creciendo con
  // cada mes de historia de la empresa. Ahora una sola query agregada recalcula todo.
  const periods = [...new Set(existing.map((r) => r.period))];
  const sums = await db
    .select({
      period: rawSql<string>`to_char(date_trunc('month', ${transactions.date}), 'YYYY-MM-DD')`.as(
        'period',
      ),
      type: transactions.type,
      total: rawSql<string>`coalesce(sum(${transactions.amountBase}), 0)`,
    })
    .from(transactions)
    .where(
      and(
        eq(transactions.companyId, companyId),
        isNull(transactions.deletedAt),
        inArray(rawSql`date_trunc('month', ${transactions.date})::date`, periods),
      ),
    )
    .groupBy(rawSql`date_trunc('month', ${transactions.date})`, transactions.type);

  const computed = new Map<string, number>();
  for (const row of sums) {
    computed.set(`${row.period}|${row.type}`, Number(row.total));
  }

  // El UPDATE sigue siendo fila por fila: metric_rollups NO es un ledger append-only
  // (no está en la lista de CLAUDE.md), así que actualizar está permitido, pero cada
  // fila tiene su propio importe y no hay un UPDATE ... FROM (VALUES) que Drizzle
  // exprese con comodidad aquí. Lo que se elimina es el SELECT+SUM por fila, que era
  // lo caro; esto son UPDATEs por PK.
  for (const row of existing) {
    if (!row.type) continue;
    const amount = computed.get(`${row.period}|${row.type}`) ?? 0;
    await upsertMonthlyRollup(db, companyId, row.period, row.type as RollupType, amount);
  }
}
