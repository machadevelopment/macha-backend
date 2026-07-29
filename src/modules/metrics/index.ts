import { Elysia, t } from 'elysia';
import { and, eq, isNull } from 'drizzle-orm';
import { tenantDerive } from '@/guards/tenant.derive';
import { assertClientCapability } from '@/guards/require-capability';
import { enforceTokenBucket, rateLimitedResponse } from '@/lib/rate-limit';
import { getOrComputeMonthlyAmount, ROLLUP_TYPES, type RollupType } from '@/lib/rollups';
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

    const series: Array<{
      period: string;
      revenue: number;
      cogs: number;
      opex: number;
      other: number;
      margin: number;
    }> = [];
    for (const period of periods) {
      const amounts: Record<RollupType, number> = { revenue: 0, cogs: 0, opex: 0, other: 0 };
      for (const type of ROLLUP_TYPES) {
        amounts[type] = await getOrComputeMonthlyAmount(db, companyId, period, type);
      }
      // Margen bruto provisional = ingresos - costo de ventas (sin restar opex).
      // No hay una definición de "margen" confirmada por Jose todavía — placeholder
      // explícito, a ajustar cuando exista esa decisión (mismo patrón que otros
      // valores provisionales de F0).
      const margin = amounts.revenue - amounts.cogs;
      series.push({ period, ...amounts, margin });
    }

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
            margin: t.Number(),
          }),
        ),
      }),
      429: rateLimitedResponse,
    },
  },
);

const AGING_BUCKETS = ['current', '1_30', '31_60', '61_90', '90_plus'] as const;
type AgingBucket = (typeof AGING_BUCKETS)[number];

function bucketFor(dueDate: string | null, today: string): AgingBucket {
  if (!dueDate || dueDate >= today) return 'current';
  const daysOverdue = Math.floor(
    (new Date(today).getTime() - new Date(dueDate).getTime()) / (1000 * 60 * 60 * 24),
  );
  if (daysOverdue <= 30) return '1_30';
  if (daysOverdue <= 60) return '31_60';
  if (daysOverdue <= 90) return '61_90';
  return '90_plus';
}

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

    const today = new Date().toISOString().slice(0, 10);

    const [openInvoices, openBills] = await Promise.all([
      db
        .select({ dueDate: invoices.dueDate, amountBase: invoices.amountBase })
        .from(invoices)
        .where(
          and(
            eq(invoices.companyId, companyId),
            eq(invoices.status, 'open'),
            isNull(invoices.deletedAt),
          ),
        ),
      db
        .select({ dueDate: bills.dueDate, amountBase: bills.amountBase })
        .from(bills)
        .where(
          and(eq(bills.companyId, companyId), eq(bills.status, 'open'), isNull(bills.deletedAt)),
        ),
    ]);

    function toBuckets(rows: { dueDate: string | null; amountBase: string }[]) {
      const totals = Object.fromEntries(AGING_BUCKETS.map((b) => [b, 0])) as Record<
        AgingBucket,
        number
      >;
      for (const row of rows) {
        totals[bucketFor(row.dueDate, today)] += Number(row.amountBase);
      }
      return totals;
    }

    return {
      baseCurrency: company?.baseCurrency ?? 'GTQ',
      ar: toBuckets(openInvoices),
      ap: toBuckets(openBills),
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
