import { Elysia, t } from 'elysia';
import { and, eq, isNull, sql as rawSql } from 'drizzle-orm';
import { tenantDerive } from '@/guards/tenant.derive';
import { assertClientCapability } from '@/guards/require-capability';
import { enforceTokenBucket, rateLimitedResponse } from '@/lib/rate-limit';
import { getOrComputeMonthlyAmounts } from '@/lib/rollups';
import { AGING_BUCKET_SQL, emptyAgingBuckets, type AgingBucket } from '@/lib/aging';
import { grossProfit, grossMarginPct } from '@/lib/margin';
import { computePeriodMetrics } from './period';
import { companies, invoices, bills } from '@/db/schema';
import { productPerformance } from './products';
import { categoryBreakdown } from './categories';

function monthStart(monthsAgo: number): string {
  const d = new Date();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() - monthsAgo);
  return d.toISOString().slice(0, 10);
}

// CU-868kfvab8. Both routes: view_dashboard_reports covers all 3 client roles (same
// matrix as view_dashboard_reports elsewhere); response shapes are TypeBox-validated
// (criterio 1); tenantDerive is the only source of company_id (criterio 2, no
// negociable); amounts are already amount_base — no currency conversion here
// (criterio 3, "sin conversión").
export const metrics = new Elysia().use(tenantDerive).get(
  '/metrics',
  async ({ companyId, role, query, set, db }) => {
    assertClientCapability(role, 'view_dashboard_reports', set);

    // CU-868kh8qhp: bucket `read` — el dashboard es justo el consumidor que motivó
    // los valores generosos de este bucket (120 rpm / 240 burst).
    const limited = await enforceTokenBucket('read', companyId, set, 'GET /metrics');
    if (limited) return limited;

    const [company] = await db
      .select({ baseCurrency: companies.baseCurrency })
      .from(companies)
      .where(eq(companies.id, companyId));

    const months = query.months ?? 12;
    const periods = Array.from({ length: months }, (_, i) => monthStart(months - 1 - i));

    // CU-868kh8w6b: esto era un doble bucle `periods × ROLLUP_TYPES` con un await por
    // combinación — 48 round-trips secuenciales con el default de 12 meses y 144 con
    // months=36. Ahora son 2 queries fijas, independientes de cuántos meses se pidan.
    // El cache-aside de metric_rollups se conserva intacto (ver lib/rollups.ts).
    const amountsByPeriod = await getOrComputeMonthlyAmounts(db, companyId, periods);

    const series = periods.map((period) => {
      const amounts = amountsByPeriod.get(period)!;
      // CU-868kh8y58: ya no es un placeholder. La definición cerrada vive en
      // lib/margin.ts y la comparten KPI, reporte y alerta.
      //
      // Se devuelven las DOS caras del mismo dato a propósito: la utilidad bruta en
      // moneda y el porcentaje. El bug del ticket era precisamente que en la misma
      // pantalla convivían una ganancia que restaba gastos y un margen que no; que el
      // backend emita el par ya calculado quita de la UI la oportunidad de recomponerlo
      // mal. `grossMarginPct` es null en un período sin ventas (ver lib/margin.ts).
      return {
        period,
        ...amounts,
        grossProfit: grossProfit(amounts.revenue, amounts.cogs),
        grossMarginPct: grossMarginPct(amounts.revenue, amounts.cogs),
        // Alias del campo anterior. Se mantiene UNA release para que el orden de
        // despliegue entre repos no importe: backend y frontend van a Railway y a
        // Vercel por separado, así que renombrar en seco rompe el dashboard en la
        // ventana entre un deploy y el otro. Sale del mismo cálculo compartido, así
        // que no puede divergir mientras exista.
        margin: grossProfit(amounts.revenue, amounts.cogs),
      };
    });

    return { baseCurrency: company?.baseCurrency ?? 'GTQ', months: series };
  },
  {
    query: t.Object({ months: t.Optional(t.Numeric({ minimum: 1, maximum: 36 })) }),
    response: {
      200: t.Object({
        baseCurrency: t.String(),
        months: t.Array(
          t.Object({
            period: t.String(),
            revenue: t.Number(),
            cogs: t.Number(),
            opex: t.Number(),
            other: t.Number(),
            grossProfit: t.Number(),
            grossMarginPct: t.Union([t.Number(), t.Null()]),
            /** @deprecated Alias de `grossProfit`; ver el comentario del handler. */
            margin: t.Number(),
          }),
        ),
      }),
      429: rateLimitedResponse,
    },
  },
);
// El rango arbitrario NO se encadena aquí: iba `.get('/period', …)` sobre esta misma
// instancia, que no lleva `prefix`, así que quedaba montado en `/period` a secas — el
// propio mensaje de su token-bucket decía `GET /metrics/period`, que era el path
// pretendido y el que llama el frontend. Vive abajo, en `metricsPeriod`, con su path
// completo. Ver la nota de aquel bloque.

/**
 * AR/AP aging (criterio de US-05/F4 dashboard, MVP: totales por antigüedad). No pasa
 * por metric_rollups — a diferencia de /metrics, esto es estado vivo (invoices/bills
 * abiertas), no una serie temporal agregable del ledger; data model.md no define un
 * rollup para AR/AP, y ambas tablas ya tienen el índice (company_id, status,
 * due_date) que esta query necesita, así que no hace falta una capa de cache-aside
 * separada para MVP.
 */
export const arAp = new Elysia().use(tenantDerive).get(
  '/ar-ap',
  async ({ companyId, role, set, db }) => {
    assertClientCapability(role, 'view_dashboard_reports', set);

    // CU-868kh8qhp: bucket `read` — misma nota que /metrics.
    const limited = await enforceTokenBucket('read', companyId, set, 'GET /ar-ap');
    if (limited) return limited;

    const [company] = await db
      .select({ baseCurrency: companies.baseCurrency })
      .from(companies)
      .where(eq(companies.id, companyId));

    // CU-868kh8w6b: antes esto traía TODAS las invoices/bills abiertas de la empresa
    // (SELECT sin LIMIT) y las agrupaba en JavaScript — transferencia y memoria
    // proporcionales al tamaño de la cartera, para devolver 10 números. Ahora Postgres
    // agrupa y devuelve como mucho 5 filas por tabla. El índice (company_id, status,
    // due_date) que ambas ya tienen cubre este filtro.
    const [arRows, apRows] = await Promise.all([
      db
        .select({ bucket: AGING_BUCKET_SQL.as('bucket'), total: rawSql<string>`sum(amount_base)` })
        .from(invoices)
        .where(
          and(
            eq(invoices.companyId, companyId),
            eq(invoices.status, 'open'),
            isNull(invoices.deletedAt),
          ),
        )
        .groupBy(AGING_BUCKET_SQL),
      db
        .select({ bucket: AGING_BUCKET_SQL.as('bucket'), total: rawSql<string>`sum(amount_base)` })
        .from(bills)
        .where(
          and(eq(bills.companyId, companyId), eq(bills.status, 'open'), isNull(bills.deletedAt)),
        )
        .groupBy(AGING_BUCKET_SQL),
    ]);

    function toBuckets(rows: { bucket: AgingBucket; total: string }[]) {
      const totals = emptyAgingBuckets();
      for (const row of rows) totals[row.bucket] = Number(row.total);
      return totals;
    }

    return {
      baseCurrency: company?.baseCurrency ?? 'GTQ',
      ar: toBuckets(arRows),
      ap: toBuckets(apRows),
    };
  },
  {
    response: {
      200: t.Object({
        baseCurrency: t.String(),
        ar: t.Object({
          current: t.Number(),
          '1_30': t.Number(),
          '31_60': t.Number(),
          '61_90': t.Number(),
          '90_plus': t.Number(),
        }),
        ap: t.Object({
          current: t.Number(),
          '1_30': t.Number(),
          '31_60': t.Number(),
          '61_90': t.Number(),
          '90_plus': t.Number(),
        }),
      }),
      429: rateLimitedResponse,
    },
  },
);

/**
 * Rutas de rango arbitrario + desagregaciones. Van en el mismo módulo que `/metrics`
 * porque comparten guard, bucket y capacidad; separarlas solo repetiría el preámbulo.
 *
 * `/metrics/period` y `/metrics/products` YA tenían su lógica escrita (`period.ts`,
 * `products.ts`) pero ninguna ruta las exponía: el frontend llamaba a las dos y recibía
 * 404. Quedaron a medio cablear entre PRs (#114 y #115) y el hueco no se veía porque
 * `app.test.ts` enumera las rutas montadas y estas no lo estaban.
 *
 * Los tres validan `from`/`to` con el mismo formato: sin eso, un rango mal escrito llega a
 * Postgres como texto y revienta con un error de casteo que el cliente no puede accionar.
 */
const RANGO_ISO = t.String({
  pattern: '^\\d{4}-\\d{2}-\\d{2}$',
  error: 'Formato esperado: YYYY-MM-DD',
});

const PERIOD_TOTALS = t.Object({
  revenue: t.Number(),
  cogs: t.Number(),
  opex: t.Number(),
  other: t.Number(),
});

/**
 * Totales de un rango ARBITRARIO + la ventana anterior del mismo tamaño + serie diaria.
 * Lo consume el filtro de período del dashboard (Hoy / Semana / Mes / Año / Custom).
 *
 * Ruta aparte de `GET /metrics` en vez de un parámetro más: aquella devuelve la serie
 * MENSUAL de los últimos N meses (y se apoya en el cache-aside de `metric_rollups`); esta
 * consulta el ledger directo porque un rango libre no encaja en el molde mensual. Son dos
 * preguntas distintas y mezclarlas en una firma haría que ninguna se entienda.
 *
 * Instancia propia con el path completo, y no `.get('/period')` encadenado a `metrics`:
 * esa instancia no lleva `prefix`, así que encadenarlo lo montaba en `/period` a secas
 * mientras el frontend llamaba `/metrics/period`.
 */
export const metricsPeriod = new Elysia().use(tenantDerive).get(
  '/metrics/period',
  async ({ companyId, role, query, set, db }) => {
    assertClientCapability(role, 'view_dashboard_reports', set);

    const limited = await enforceTokenBucket('read', companyId, set, 'GET /metrics/period');
    if (limited) return limited;

    // El patrón del query solo garantiza la FORMA de cada fecha, no su orden. Un rango al
    // revés no da error en Postgres: da cero filas, o sea unos KPIs en cero que se leen
    // como "no vendí nada" en vez de como "escribiste mal el rango".
    if (query.from > query.to) {
      set.status = 400;
      return { error: 'El rango es inválido: la fecha inicial es posterior a la final.' };
    }

    const [company] = await db
      .select({ baseCurrency: companies.baseCurrency })
      .from(companies)
      .where(eq(companies.id, companyId));

    const { current, previous, series, dataRange } = await computePeriodMetrics(
      db,
      companyId,
      query.from,
      query.to,
    );

    return {
      baseCurrency: company?.baseCurrency ?? 'GTQ',
      // Se devuelve el rango consultado: la UI dispara varias peticiones al cambiar de
      // filtro y sin esto no puede distinguir la respuesta que pidió de una tardía.
      from: query.from,
      to: query.to,
      current,
      previous,
      series,
      // CU-868krn2up: primer y último día con movimientos de la empresa, para que un
      // período en cero pueda distinguirse de un producto roto. Ver `rangoConDatos`.
      dataRange,
    };
  },
  {
    query: t.Object({ from: RANGO_ISO, to: RANGO_ISO }),
    response: {
      200: t.Object({
        baseCurrency: t.String(),
        from: t.String(),
        to: t.String(),
        current: PERIOD_TOTALS,
        previous: PERIOD_TOTALS,
        series: t.Array(t.Composite([t.Object({ date: t.String() }), PERIOD_TOTALS])),
        // `null` cuando la empresa no tiene ni una transacción viva — que es distinto de
        // "no tiene en este rango", y la UI necesita separarlos para decir la frase
        // correcta ("todavía no subiste nada" vs. "no hay nada en este período").
        dataRange: t.Union([t.Object({ from: t.String(), to: t.String() }), t.Null()]),
      }),
      400: t.Object({ error: t.String() }),
      429: rateLimitedResponse,
    },
  },
);

export const metricsProducts = new Elysia().use(tenantDerive).get(
  '/metrics/products',
  async ({ companyId, role, query, set, db }) => {
    assertClientCapability(role, 'view_dashboard_reports', set);

    const limited = await enforceTokenBucket('read', companyId, set, 'GET /metrics/products');
    if (limited) return limited;

    const [company] = await db
      .select({ baseCurrency: companies.baseCurrency })
      .from(companies)
      .where(eq(companies.id, companyId));

    const items = await productPerformance(db, companyId, query.from, query.to, query.limit ?? 10);

    return { baseCurrency: company?.baseCurrency ?? 'GTQ', items };
  },
  {
    query: t.Object({
      from: RANGO_ISO,
      to: RANGO_ISO,
      // Techo de 200: la pantalla de Ventas por producto lista el catálogo completo de una
      // PYME, no un top 5. Sin techo, una empresa con miles de SKUs se traería todo a la
      // tabla y la dejaría inservible además de lenta.
      limit: t.Optional(t.Numeric({ minimum: 1, maximum: 200 })),
    }),
    response: {
      200: t.Object({
        baseCurrency: t.String(),
        items: t.Array(
          t.Object({
            productId: t.String(),
            name: t.String(),
            category: t.Union([t.String(), t.Null()]),
            revenue: t.Number(),
            cogs: t.Number(),
            grossProfit: t.Number(),
            grossMarginPct: t.Union([t.Number(), t.Null()]),
            // `null` = ninguna fila de venta de este producto traía unidades. No es 0.
            units: t.Union([t.Number(), t.Null()]),
            revenueWithUnits: t.Number(),
            transactionCount: t.Number(),
            revenueSharePct: t.Number(),
            previousRevenue: t.Number(),
            trend: t.Union([t.Literal('up'), t.Literal('down'), t.Literal('flat')]),
          }),
        ),
      }),
      429: rateLimitedResponse,
    },
  },
);

export const metricsCategories = new Elysia().use(tenantDerive).get(
  '/metrics/categories',
  async ({ companyId, role, query, set, db }) => {
    assertClientCapability(role, 'view_dashboard_reports', set);

    const limited = await enforceTokenBucket('read', companyId, set, 'GET /metrics/categories');
    if (limited) return limited;

    const [company] = await db
      .select({ baseCurrency: companies.baseCurrency })
      .from(companies)
      .where(eq(companies.id, companyId));

    const rows = await categoryBreakdown(db, companyId, query.from, query.to);

    return { baseCurrency: company?.baseCurrency ?? 'GTQ', rows };
  },
  {
    query: t.Object({ from: RANGO_ISO, to: RANGO_ISO }),
    response: {
      200: t.Object({
        baseCurrency: t.String(),
        rows: t.Array(
          t.Object({
            category: t.String(),
            type: t.Union([
              t.Literal('revenue'),
              t.Literal('cogs'),
              t.Literal('opex'),
              t.Literal('other'),
            ]),
            total: t.Number(),
            transactionCount: t.Number(),
            sharePct: t.Number(),
          }),
        ),
      }),
      429: rateLimitedResponse,
    },
  },
);
