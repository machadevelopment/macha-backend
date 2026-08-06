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
export const metrics = new Elysia()
  .use(tenantDerive)
  .get(
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
  )
  /**
   * Totales de un rango ARBITRARIO + la ventana anterior del mismo tamaño + serie diaria.
   * Lo consume el filtro de período del dashboard (Hoy / Semana / Mes / Año / Custom).
   *
   * Ruta aparte de `GET /metrics` en vez de un parámetro más: aquella devuelve la serie
   * MENSUAL de los últimos N meses (y se apoya en el cache-aside de `metric_rollups`);
   * esta consulta el ledger directo porque un rango libre no encaja en el molde mensual.
   * Son dos preguntas distintas y mezclarlas en una firma haría que ninguna se entienda.
   */
  .get(
    '/period',
    async ({ companyId, role, query, set, db }) => {
      assertClientCapability(role, 'view_dashboard_reports', set);

      const limited = await enforceTokenBucket('read', companyId, set, 'GET /metrics/period');
      if (limited) return limited;

      if (query.from > query.to) {
        set.status = 400;
        return { error: 'El rango es inválido: la fecha inicial es posterior a la final.' };
      }

      const [company] = await db
        .select({ baseCurrency: companies.baseCurrency })
        .from(companies)
        .where(eq(companies.id, companyId));

      const { current, previous, series } = await computePeriodMetrics(
        db,
        companyId,
        query.from,
        query.to,
      );

      return {
        baseCurrency: company?.baseCurrency ?? 'GTQ',
        from: query.from,
        to: query.to,
        current,
        previous,
        series,
      };
    },
    {
      query: t.Object({
        from: t.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}$' }),
        to: t.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}$' }),
      }),
    },
  );

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
