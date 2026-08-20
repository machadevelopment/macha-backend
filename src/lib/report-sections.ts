import { and, desc, eq, gte, isNull, lte, sql as rawSql } from 'drizzle-orm';
import type { DB } from '@/db/client';
import { alertEvents, alertRules, bills, invoices, transactions } from '@/db/schema';
import { alertCatalog } from '@/config/alert-catalog';
import { AGING_BUCKET_SQL, emptyAgingBuckets, type AgingBucket } from '@/lib/aging';
import { grossMarginPct, grossProfit } from '@/lib/margin';
import {
  computePeriodMetrics,
  type PeriodPoint,
  type PeriodTotals,
} from '@/modules/metrics/period';
import { categoryBreakdown, type CategoryBreakdownRow } from '@/modules/metrics/categories';
import { productPerformance, type ProductPerformance } from '@/modules/metrics/products';

/**
 * CATÁLOGO DE SECCIONES DE UN REPORTE (CU-B2-QA-20260811).
 *
 * Una sección no es una casilla de "mostrar/ocultar": decide QUÉ SE CALCULA (qué queries
 * se lanzan contra el ledger) y QUÉ SE LE PIDE A LA IA. Pedir un reporte de solo KPIs no
 * debe costar las cuatro consultas de producto ni gastar tokens narrando categorías que
 * nadie pidió.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────
 * POR QUÉ `cash_flow` NO ESTÁ EN ESTA LISTA
 * ─────────────────────────────────────────────────────────────────────────────────────
 * El ticket pedía confirmar cuáles secciones son viables antes de aceptarlas. `cash_flow`
 * NO lo es, y no por falta de tiempo: HOY NO EXISTE EL DATO. Verificado sobre el esquema
 * y sobre todos los caminos de escritura del repo:
 *
 *  1. `transactions` registra el HECHO contable (fecha, tipo, categoría, monto). No tiene
 *     ni fecha de cobro/pago, ni cuenta bancaria, ni marca de caja vs. devengado. Sumar
 *     revenue − cogs − opex por fecha da un RESULTADO, no un flujo de caja; presentarlo
 *     con ese nombre sería exactamente la cifra inventada que el PRD prohíbe.
 *  2. `invoices.status` / `bills.status` admiten 'paid', pero NINGÚN camino del código lo
 *     escribe: `lib/promotion.ts` inserta siempre con `status: 'open'` y no hay UPDATE de
 *     estado en ninguna parte. Toda cuenta nace abierta y muere abierta.
 *  3. `settled_transaction_id` existe como columna y como FK compuesta desde la migración
 *     0001 y NADIE la escribe nunca. Sin ella no hay forma de saber en qué fecha se cobró
 *     una factura, que es el dato mínimo para un flujo de caja.
 *  4. `payments` sí tiene fechas reales, pero es la facturación de Macha vía Recurrente
 *     (lo que el cliente nos paga a NOSOTROS). No tiene nada que ver con la caja del
 *     cliente.
 *
 * Ni `PRD.md` ni `data model.md` definen flujo de caja en ninguna parte. Cuando exista un
 * dato de cobro/pago con fecha, la sección se agrega aquí y en ningún otro sitio.
 *
 * `risks` SÍ es viable, pero conviene decir con qué: son los `alert_events` YA EVALUADOS
 * en el período por el motor determinista (`lib/alerts.ts`) más la antigüedad viva de
 * AR/AP. El reporte LEE ese historial, nunca reevalúa: reevaluar insertaría eventos y
 * dispararía correos como efecto colateral de mirar un reporte.
 */
export const REPORT_SECTIONS = [
  'kpis',
  'revenue_trend',
  'cost_breakdown',
  'top_products',
  'risks',
  'recommendations',
] as const;

export type ReportSection = (typeof REPORT_SECTIONS)[number];

/**
 * Tipos de reporte.
 *
 * Arrancó con uno solo y COMPLETO (decisión del ticket B2), con la forma de catálogo desde
 * el día uno para que agregar el segundo fuera una entrada en esta lista y su juego de
 * secciones, no una refactorización. Esto es cobrar esa apuesta.
 *
 * ═══ CUATRO Y NO SEIS (CU-868ku9rpy) ═══
 *
 * El prototipo ofrece seis: resumen ejecutivo, desempeño financiero, análisis de flujo de
 * caja, análisis de costos, ventas y productos, y **personal y plantilla**. Van cuatro.
 *
 * Los dos que no van, y por qué NO es pereza:
 *
 *   · `workforce` (personal y plantilla) — el ledger no tiene nómina. Sus movimientos son
 *     `revenue`/`cogs`/`opex`/`other`; el gasto de planilla cae dentro de `opex` sin
 *     distinguirse del alquiler o del software. Un reporte de plantilla que no puede contar
 *     empleados ni separar su costo sería un título con las mismas cifras de siempre debajo.
 *   · `cash_flow` como tipo APARTE — la caja del período, con datos de base acumulativa, es
 *     exactamente `revenue - cogs - opex`, o sea la misma resta que la utilidad. Ya está
 *     documentado en `analytics/kpi-header.tsx`: una caja de verdad distinta exige base de
 *     EFECTIVO (fechar por cuándo se cobró, no por cuándo se facturó) y ningún endpoint
 *     expone eso todavía. Dos tipos de reporte con el mismo contenido y nombres distintos
 *     es peor que uno: en un producto financiero, dos títulos distintos prometen dos
 *     análisis distintos.
 *
 * Los cuatro que van se arman ENTERAMENTE con secciones que ya existen y se calculan hoy.
 * Ninguno necesita un dato que el backend no tenga, que es la única razón por la que se
 * pueden agregar en una lista.
 */
export const REPORT_TYPES = [
  'executive_summary',
  'financial_performance',
  'cost_analysis',
  'sales_performance',
] as const;
export type ReportType = (typeof REPORT_TYPES)[number];

/**
 * Secciones por defecto de cada tipo.
 *
 * `executive_summary` por defecto es `kpis` + `recommendations`: EXACTAMENTE lo que el
 * tick diario venía produciendo desde CU-868kfvacg (métricas por SQL + narrativa con 1-2
 * recomendaciones). Es deliberado — el cron se mantiene y no debe cambiar de
 * comportamiento por un ticket que agrega la vía manual.
 */
export const DEFAULT_SECTIONS: Record<ReportType, ReportSection[]> = {
  executive_summary: ['kpis', 'recommendations'],
  /*
   * CU-868ku9rpy. Cada juego se elige por lo que el TIPO promete, no por incluir todo lo
   * disponible: un reporte que trae las seis secciones siempre no es un tipo, es un volcado
   * con seis nombres. El usuario puede agregar o quitar secciones a mano — esto es el punto
   * de partida que hace que elegir el tipo signifique algo.
   */
  financial_performance: ['kpis', 'revenue_trend', 'cost_breakdown', 'recommendations'],
  cost_analysis: ['kpis', 'cost_breakdown', 'risks', 'recommendations'],
  sales_performance: ['kpis', 'revenue_trend', 'top_products', 'recommendations'],
};

export interface ReportKpis {
  revenue: number;
  cogs: number;
  opex: number;
  other: number;
  grossProfit: number;
  grossMarginPct: number | null;
  /** @deprecated Alias de `grossProfit`; ver la nota de `computeKpis`. */
  margin: number;
  accountsReceivableOpen: number;
  accountsPayableOpen: number;
}

export interface ReportRiskAlert {
  ruleKey: string;
  label: string;
  threshold: number;
  triggeredValue: number;
  unit: 'percent' | 'days';
  occurredAt: string;
}

export interface ReportRisks {
  /** Alertas que YA dispararon dentro del período. Historial, no reevaluación. */
  alerts: ReportRiskAlert[];
  /**
   * Antigüedad de cuentas por cobrar/pagar. Es ESTADO VIVO —se mide contra
   * `current_date`, igual que `GET /ar-ap`—, no una foto del cierre del período: las
   * tablas no guardan histórico de saldos, así que no hay forma de reconstruir cómo se
   * veía la cartera hace tres meses. Quien lea el reporte tiene que saberlo, por eso
   * viaja con su propia marca de fecha.
   */
  agingAsOf: string;
  arAging: Record<AgingBucket, number>;
  apAging: Record<AgingBucket, number>;
}

export interface ReportRevenueTrend {
  current: PeriodTotals;
  previous: PeriodTotals;
  series: PeriodPoint[];
}

export interface ReportData {
  periodStart: string;
  periodEnd: string;
  reportType: ReportType;
  sections: ReportSection[];
  kpis?: ReportKpis;
  revenueTrend?: ReportRevenueTrend;
  costBreakdown?: CategoryBreakdownRow[];
  topProducts?: ProductPerformance[];
  risks?: ReportRisks;
}

/**
 * CU-868kfvacr/868kfvacg: métricas calculadas en SQL directo sobre el ledger para el
 * rango exacto del reporte (periodStart..periodEnd) — NO vía metric_rollups, porque los
 * rollups solo tienen granularidad month/quarter/year y un rango libre no cae en bordes
 * de mes. La IA nunca ve esta query, solo su resultado (regla no negociable: "la IA
 * narra, nunca calcula").
 *
 * Vive aquí y ya no en `lib/reports.ts` porque dejó de ser "las métricas del reporte"
 * para ser UNA SECCIÓN entre varias; dejarla en el orquestador obligaría a que ese
 * archivo conociera el SQL de una sección y no el de las otras cinco.
 */
export async function computeKpis(
  db: DB,
  companyId: string,
  periodStart: string,
  periodEnd: string,
): Promise<ReportKpis> {
  const byType = await db
    .select({ type: transactions.type, total: rawSql<string>`sum(${transactions.amountBase})` })
    .from(transactions)
    .where(
      and(
        eq(transactions.companyId, companyId),
        isNull(transactions.deletedAt),
        gte(transactions.date, periodStart),
        lte(transactions.date, periodEnd),
      ),
    )
    .groupBy(transactions.type);

  const totals: Record<string, number> = { revenue: 0, cogs: 0, opex: 0, other: 0 };
  for (const row of byType) totals[row.type] = Number(row.total);

  const [arRow] = await db
    .select({ total: rawSql<string>`coalesce(sum(${invoices.amountBase}), 0)` })
    .from(invoices)
    .where(
      and(
        eq(invoices.companyId, companyId),
        eq(invoices.status, 'open'),
        isNull(invoices.deletedAt),
      ),
    );
  const [apRow] = await db
    .select({ total: rawSql<string>`coalesce(sum(${bills.amountBase}), 0)` })
    .from(bills)
    .where(and(eq(bills.companyId, companyId), eq(bills.status, 'open'), isNull(bills.deletedAt)));

  return {
    revenue: totals.revenue!,
    cogs: totals.cogs!,
    opex: totals.opex!,
    other: totals.other!,
    // CU-868kh8y58: misma definición que el KPI del dashboard y que la alerta
    // `margin_drop`, vía lib/margin.ts.
    grossProfit: grossProfit(totals.revenue!, totals.cogs!),
    grossMarginPct: grossMarginPct(totals.revenue!, totals.cogs!),
    // El alias sobrevive por una razón más fuerte que en el endpoint de métricas: este
    // objeto se GUARDA en `report_versions.metrics`, que es un ledger append-only (REVOKE
    // UPDATE,DELETE en 0010). Las versiones ya emitidas conservan para siempre la forma
    // vieja y no hay migración posible, así que el lector tiene que aguantar las dos
    // formas de todos modos; emitirlo también en las nuevas mantiene un solo campo común
    // entre ambas generaciones. Sale del mismo cálculo, no puede divergir.
    margin: grossProfit(totals.revenue!, totals.cogs!),
    accountsReceivableOpen: Number(arRow?.total ?? 0),
    accountsPayableOpen: Number(apRow?.total ?? 0),
  };
}

/**
 * Riesgos = historial de alertas del período + antigüedad viva de AR/AP.
 *
 * SE LEE `alert_events`, NO SE REEVALÚA. `evaluateAlerts()` no es una función pura: por
 * cada regla que se cumple INSERTA una fila en `alert_events` y puede mandar correo a
 * toda la empresa. Llamarla desde la generación de un reporte convertiría "mirar un
 * resumen" en "disparar notificaciones", y además falsearía el control de repetición de 7
 * días que evita el spam. El motor corre donde tiene que correr —tras cada ingesta
 * exitosa— y el reporte cuenta lo que ese motor ya encontró.
 */
export async function computeRisks(
  db: DB,
  companyId: string,
  periodStart: string,
  periodEnd: string,
): Promise<ReportRisks> {
  // `alert_events.created_at` es timestamptz y el período son dos `date`. El límite
  // superior es el instante final del día `periodEnd`, no su medianoche inicial: con
  // `<= periodEnd 00:00` se perdería todo lo que disparó el último día del rango.
  const desde = new Date(`${periodStart}T00:00:00.000Z`);
  const hasta = new Date(`${periodEnd}T23:59:59.999Z`);

  const events = await db
    .select({
      ruleKey: alertRules.ruleKey,
      threshold: alertRules.threshold,
      triggeredValue: alertEvents.triggeredValue,
      createdAt: alertEvents.createdAt,
    })
    .from(alertEvents)
    .innerJoin(alertRules, eq(alertRules.id, alertEvents.alertRuleId))
    .where(
      and(
        eq(alertEvents.companyId, companyId),
        gte(alertEvents.createdAt, desde),
        lte(alertEvents.createdAt, hasta),
      ),
    )
    .orderBy(desc(alertEvents.createdAt))
    // Techo duro: una empresa con ingestas diarias acumula eventos, y un reporte no
    // necesita los 400 — necesita los que caben en una página y en un prompt.
    .limit(50);

  const alerts: ReportRiskAlert[] = events.map((e) => {
    const entry = alertCatalog.find((c) => c.ruleKey === e.ruleKey);
    return {
      ruleKey: e.ruleKey,
      label: entry?.label ?? e.ruleKey,
      threshold: Number(e.threshold),
      triggeredValue: Number(e.triggeredValue),
      unit: entry?.unit ?? 'percent',
      occurredAt: e.createdAt.toISOString(),
    };
  });

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
      .where(and(eq(bills.companyId, companyId), eq(bills.status, 'open'), isNull(bills.deletedAt)))
      .groupBy(AGING_BUCKET_SQL),
  ]);

  const aBuckets = (rows: { bucket: AgingBucket; total: string }[]) => {
    const totals = emptyAgingBuckets();
    for (const row of rows) totals[row.bucket] = Number(row.total);
    return totals;
  };

  return {
    alerts,
    agingAsOf: new Date().toISOString().slice(0, 10),
    arAging: aBuckets(arRows),
    apAging: aBuckets(apRows),
  };
}

/** Normaliza y ordena un conjunto de secciones; descarta repetidas y desconocidas. */
export function normalizeSections(input: readonly string[]): ReportSection[] {
  const pedidas = new Set(input);
  return REPORT_SECTIONS.filter((s) => pedidas.has(s));
}

/**
 * Calcula SOLO las secciones pedidas. Las consultas independientes van en paralelo: son
 * cuatro familias de queries sobre índices distintos y encadenarlas solo suma latencia a
 * un job que ya espera una llamada a Claude después.
 *
 * `recommendations` no aparece aquí a propósito: no tiene datos propios: es una
 * instrucción para la narrativa (ver `lib/report-prompt.ts`). Que no calcule nada no la
 * hace decorativa — cambia lo que se le pide a la IA, que es el otro eje del ticket.
 */
export async function computeReportSections(
  db: DB,
  companyId: string,
  periodStart: string,
  periodEnd: string,
  reportType: ReportType,
  sections: ReportSection[],
): Promise<ReportData> {
  const quiere = (s: ReportSection) => sections.includes(s);

  const [kpis, revenueTrend, costBreakdown, topProducts, risks] = await Promise.all([
    quiere('kpis') ? computeKpis(db, companyId, periodStart, periodEnd) : undefined,
    quiere('revenue_trend')
      ? computePeriodMetrics(db, companyId, periodStart, periodEnd)
      : undefined,
    // Solo costo y gasto: la sección se llama "desglose de costos" y meter las categorías
    // de ingreso ahí obligaría al lector a separar a ojo dos cosas de signo contrario.
    quiere('cost_breakdown')
      ? categoryBreakdown(db, companyId, periodStart, periodEnd).then((filas) =>
          filas.filter((f) => f.type === 'cogs' || f.type === 'opex'),
        )
      : undefined,
    quiere('top_products')
      ? productPerformance(db, companyId, periodStart, periodEnd, 10)
      : undefined,
    quiere('risks') ? computeRisks(db, companyId, periodStart, periodEnd) : undefined,
  ]);

  return {
    periodStart,
    periodEnd,
    reportType,
    sections,
    ...(kpis ? { kpis } : {}),
    ...(revenueTrend ? { revenueTrend } : {}),
    ...(costBreakdown ? { costBreakdown } : {}),
    ...(topProducts ? { topProducts } : {}),
    ...(risks ? { risks } : {}),
  };
}

/**
 * Forma con la que `ReportData` se persiste en `report_versions.metrics`.
 *
 * Los campos de KPI van APLANADOS EN LA RAÍZ, no bajo `kpis`, y no es descuido: así ha
 * sido `metrics` desde el primer reporte y `report_versions` es append-only, así que
 * ninguna fila vieja se puede migrar a otra forma. El frontend lee `metrics.revenue`. Un
 * anidamiento nuevo obligaría a todo lector a soportar dos formas para siempre a cambio
 * de nada; las secciones nuevas, en cambio, van bajo su propia clave porque no colisionan
 * con nada existente.
 */
export function toStoredMetrics(data: ReportData): Record<string, unknown> {
  const { kpis, ...resto } = data;
  return { schemaVersion: 2, ...resto, ...(kpis ?? {}) };
}

/** Inverso de `toStoredMetrics`, tolerante con las filas anteriores a este ticket. */
export function fromStoredMetrics(stored: Record<string, unknown>): ReportData {
  const secciones = Array.isArray(stored.sections)
    ? normalizeSections(stored.sections as string[])
    : // Una versión anterior a este ticket no guardó `sections` y siempre traía KPIs +
      // narrativa con recomendaciones. Eso es exactamente el juego por defecto.
      DEFAULT_SECTIONS.executive_summary;

  const tieneKpis = typeof stored.revenue === 'number';

  return {
    periodStart: String(stored.periodStart ?? ''),
    periodEnd: String(stored.periodEnd ?? ''),
    reportType: (REPORT_TYPES as readonly string[]).includes(String(stored.reportType))
      ? (stored.reportType as ReportType)
      : 'executive_summary',
    sections: secciones,
    ...(tieneKpis
      ? {
          kpis: {
            revenue: Number(stored.revenue ?? 0),
            cogs: Number(stored.cogs ?? 0),
            opex: Number(stored.opex ?? 0),
            other: Number(stored.other ?? 0),
            grossProfit: Number(stored.grossProfit ?? 0),
            grossMarginPct:
              stored.grossMarginPct === null || stored.grossMarginPct === undefined
                ? null
                : Number(stored.grossMarginPct),
            margin: Number(stored.margin ?? stored.grossProfit ?? 0),
            accountsReceivableOpen: Number(stored.accountsReceivableOpen ?? 0),
            accountsPayableOpen: Number(stored.accountsPayableOpen ?? 0),
          },
        }
      : {}),
    ...(stored.revenueTrend ? { revenueTrend: stored.revenueTrend as ReportRevenueTrend } : {}),
    ...(stored.costBreakdown
      ? { costBreakdown: stored.costBreakdown as CategoryBreakdownRow[] }
      : {}),
    ...(stored.topProducts ? { topProducts: stored.topProducts as ProductPerformance[] } : {}),
    ...(stored.risks ? { risks: stored.risks as ReportRisks } : {}),
  };
}
