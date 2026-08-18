import { and, eq, gte, isNull, lte, sql as rawSql } from 'drizzle-orm';
import type { DB } from '@/db/client';
import {
  alertRules,
  alertEvents,
  invoices,
  transactions,
  companies,
  companyUsers,
  users,
} from '@/db/schema';
import { getOrComputeMonthlyAmount } from '@/lib/rollups';
import { getCreditBalance } from '@/lib/credits';
import { creditsConfig } from '@/config/credits';
import { getPlatformSetting, SETTINGS_KEYS } from '@/lib/settings';
import { sendAlertTriggeredEmail } from '@/lib/email';
import { alertCatalog } from '@/config/alert-catalog';
import { alertUrl } from '@/lib/app-urls';
import { grossMarginPct } from '@/lib/margin';

const NO_REPEAT_DAYS = 7;

function monthStart(monthsAgo: number): string {
  const d = new Date();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() - monthsAgo);
  return d.toISOString().slice(0, 10);
}

/** Último día del mes que empieza en `inicio` (YYYY-MM-DD). */
function monthEnd(inicio: string): string {
  const [y, m] = inicio.split('-').map(Number);
  // Día 0 del mes SIGUIENTE = último día de éste, y `Date.UTC` ya normaliza el desborde de
  // diciembre a enero del año siguiente sin que haya que tratarlo aparte.
  return new Date(Date.UTC(y!, m!, 0)).toISOString().slice(0, 10);
}

/**
 * Lo que devuelve un evaluador: el valor que disparó y, cuando la regla mira un período
 * concreto, CUÁL fue y contra qué se comparó.
 *
 * CU-868kt94an: antes era un `number` pelado y esa era media causa del problema. Una
 * alerta sin período no se puede verificar ("¿52 % de qué contra qué?"), y cuando el
 * usuario le preguntó al asesor, el asesor calculó su propia ventana y salió otro número.
 * Ninguno de los dos estaba mal; ninguno de los dos decía de qué mes hablaba.
 */
export interface ResultadoDeRegla {
  value: number;
  periodStart?: string;
  periodEnd?: string;
  baseline?: number;
}

async function evalArOverdue(
  db: DB,
  companyId: string,
  threshold: number,
): Promise<ResultadoDeRegla | null> {
  const today = new Date().toISOString().slice(0, 10);
  const rows = await db
    .select({ dueDate: invoices.dueDate })
    .from(invoices)
    .where(
      and(
        eq(invoices.companyId, companyId),
        eq(invoices.status, 'open'),
        isNull(invoices.deletedAt),
      ),
    );

  let maxDaysOverdue = 0;
  for (const row of rows) {
    if (!row.dueDate || row.dueDate >= today) continue;
    const days = Math.floor((Date.parse(today) - Date.parse(row.dueDate)) / 86_400_000);
    maxDaysOverdue = Math.max(maxDaysOverdue, days);
  }
  return maxDaysOverdue >= threshold ? { value: maxDaysOverdue } : null;
}

async function evalPortfolioConcentration(
  db: DB,
  companyId: string,
  threshold: number,
): Promise<ResultadoDeRegla | null> {
  const rows = await db
    .select({
      counterparty: invoices.counterparty,
      total: rawSql<string>`sum(${invoices.amountBase})`,
    })
    .from(invoices)
    .where(
      and(
        eq(invoices.companyId, companyId),
        eq(invoices.status, 'open'),
        isNull(invoices.deletedAt),
      ),
    )
    .groupBy(invoices.counterparty);

  const grandTotal = rows.reduce((acc, r) => acc + Number(r.total), 0);
  if (grandTotal === 0) return null;
  const maxShare = Math.max(...rows.map((r) => (Number(r.total) / grandTotal) * 100));
  return maxShare >= threshold ? { value: maxShare } : null;
}

/**
 * "Caída de ingresos" — CU-868kt94an, reescrita. Antes producía falsas alarmas por
 * construcción, y no de a poco: **18 de las 25 alertas de esta regla en producción marcaban
 * exactamente 100,0000 %.**
 *
 * ═══ QUÉ HACÍA ═══
 *
 * Comparaba el MES EN CURSO contra el promedio de los 3 anteriores. El mes en curso está a
 * medio transcurrir y los otros tres están completos, así que la comparación está sesgada
 * SIEMPRE — y el sesgo es máximo justo donde más ruido hace:
 *
 *   · el día 1 de cada mes, todas las empresas "cayeron ~100 %";
 *   · en la primera carga de un cliente, que sube su histórico hasta el mes pasado, el mes
 *     en curso vale 0 y la primera alerta que recibe en su vida es "tus ingresos cayeron
 *     100 %". De ahí salen las 18.
 *
 * Y el caso sutil, que es el que llegó como reporte: Candelas, el 17 de agosto, disparó
 * 52,3 %. La cuenta era correcta —promedio may/jun/jul = 2.217,69 contra 1.058,17 de
 * agosto— pero comparaba DIECISIETE DÍAS contra tres meses enteros. A ese ritmo la empresa
 * iba a cerrar agosto en ~1.930, o sea plana. No había caída.
 *
 * ═══ QUÉ HACE AHORA ═══
 *
 * Compara MESES COMPLETOS: el último mes cerrado contra los 3 anteriores a él. Se pierde
 * inmediatez —la caída de agosto se avisa en septiembre— y se gana que el número sea
 * verificable: el dueño puede abrir su dashboard, filtrar ese mes y llegar al mismo dato.
 * Una alerta que no se puede reproducir a mano no es un aviso, es un rumor; y una que grita
 * todos los días 1 se aprende a ignorar, que es la peor falla posible en un sistema de
 * alertas.
 *
 * Con la regla nueva, Candelas SIGUE disparando: julio (1.638,41) contra el promedio de
 * abr/may/jun (2.191,90) es una caída del 25,2 %, por encima de su umbral del 15 %. O sea
 * que esto no silencia señales reales — quita el ruido del calendario.
 *
 * ═══ "SIN DATOS" NO ES "CERO VENTAS" ═══
 *
 * Si el mes evaluado no tiene NINGÚN movimiento —de ningún tipo— es que no se ha cargado,
 * no que la empresa dejó de vender. Se devuelve `null`. La distinción importa: un mes con
 * gastos y sin ingresos SÍ es una caída del 100 % que hay que avisar, y ese caso sigue
 * disparando.
 */
async function evalRevenueDrop(
  db: DB,
  companyId: string,
  threshold: number,
): Promise<ResultadoDeRegla | null> {
  const evaluado = monthStart(1);
  const current = await getOrComputeMonthlyAmount(db, companyId, evaluado, 'revenue');
  const priors = await Promise.all(
    [2, 3, 4].map((i) => getOrComputeMonthlyAmount(db, companyId, monthStart(i), 'revenue')),
  );
  const avgPrior = priors.reduce((a, b) => a + b, 0) / priors.length;
  if (avgPrior === 0) return null;

  if (current === 0 && !(await tuvoMovimiento(db, companyId, evaluado))) return null;

  const dropPct = ((avgPrior - current) / avgPrior) * 100;
  if (dropPct < threshold) return null;
  return {
    value: dropPct,
    periodStart: evaluado,
    periodEnd: monthEnd(evaluado),
    baseline: avgPrior,
  };
}

/**
 * ¿La empresa tiene algún movimiento cargado en ese mes? Cualquier tipo sirve: la pregunta
 * es si HAY DATOS, no si hubo ventas.
 */
async function tuvoMovimiento(db: DB, companyId: string, mes: string): Promise<boolean> {
  const [fila] = await db
    .select({ hay: rawSql<number>`1` })
    .from(transactions)
    .where(
      and(
        eq(transactions.companyId, companyId),
        isNull(transactions.deletedAt),
        gte(transactions.date, mes),
        lte(transactions.date, monthEnd(mes)),
      ),
    )
    .limit(1);
  return Boolean(fila);
}

async function evalMarginDrop(
  db: DB,
  companyId: string,
  threshold: number,
): Promise<ResultadoDeRegla | null> {
  const period = monthStart(0);
  const revenue = await getOrComputeMonthlyAmount(db, companyId, period, 'revenue');
  const cogs = await getOrComputeMonthlyAmount(db, companyId, period, 'cogs');
  // CU-868kh8y58: la misma función que el KPI y el reporte. `null` cuando no hubo
  // ventas — un mes sin facturar no dispara "margen bajo" (ver lib/margin.ts).
  const marginPct = grossMarginPct(revenue, cogs);
  if (marginPct === null) return null;
  // Sí lleva período: el margen se mide sobre un mes concreto, y sin decir cuál pasa lo
  // mismo que con la caída de ingresos (CU-868kt94an).
  return marginPct < threshold
    ? { value: marginPct, periodStart: period, periodEnd: monthEnd(period) }
    : null;
}

/**
 * "Una categoría de costo supera su promedio de 3 meses" (alert-catalog.ts) —
 * evaluada por (type, category) real, no solo por type, porque `category` es el
 * único nivel de detalle que el ledger tiene además del tipo fijo. Requiere que la
 * categoría tenga gasto en los 3 meses previos (si no, se ignora — "requiere >=3
 * meses de historia"); devuelve la MAYOR desviación entre todas las categorías.
 */
async function evalSpendOutOfRange(
  db: DB,
  companyId: string,
  threshold: number,
): Promise<ResultadoDeRegla | null> {
  const periods = [0, 1, 2, 3].map(monthStart);
  const rows = await db
    .select({
      category: transactions.category,
      type: transactions.type,
      period: rawSql<string>`date_trunc('month', ${transactions.date})::date`,
      total: rawSql<string>`sum(${transactions.amountBase})`,
    })
    .from(transactions)
    .where(
      and(
        eq(transactions.companyId, companyId),
        rawSql`${transactions.type} in ('cogs','opex')`,
        isNull(transactions.deletedAt),
        gte(transactions.date, periods[3]!),
      ),
    )
    .groupBy(
      transactions.category,
      transactions.type,
      rawSql`date_trunc('month', ${transactions.date})`,
    );

  const byCategory = new Map<string, Map<string, number>>();
  for (const row of rows) {
    const key = `${row.type}:${row.category}`;
    if (!byCategory.has(key)) byCategory.set(key, new Map());
    byCategory.get(key)!.set(row.period, Number(row.total));
  }

  let maxDeviation: number | null = null;
  for (const [, byPeriod] of byCategory) {
    const priorMonths = [1, 2, 3].map((i) => byPeriod.get(periods[i]!));
    if (priorMonths.some((v) => v === undefined)) continue; // needs full 3-month history
    const avgPrior = (priorMonths as number[]).reduce((a, b) => a + b, 0) / 3;
    if (avgPrior === 0) continue;
    const current = byPeriod.get(periods[0]!) ?? 0;
    const deviationPct = ((current - avgPrior) / avgPrior) * 100;
    if (deviationPct >= threshold && (maxDeviation === null || deviationPct > maxDeviation)) {
      maxDeviation = deviationPct;
    }
  }
  // Las reglas que no comparan contra un período fijo devuelven solo el valor. No se les
  // inventa un rango: un `period` falso es peor que la ausencia, porque parece verificable.
  return maxDeviation === null ? null : { value: maxDeviation };
}

async function evalLowCreditBalance(
  db: DB,
  companyId: string,
  threshold: number,
): Promise<ResultadoDeRegla | null> {
  const balance = await getCreditBalance(db, companyId);
  // CU-868kfvafy criterio 1: configurable desde el panel (platform_settings), nunca
  // en código — creditsConfig.monthlyAllotment queda solo como fallback si el admin
  // nunca lo tocó (entorno recién migrado, sin seed).
  const monthlyAllotment = Number(
    await getPlatformSetting(
      db,
      SETTINGS_KEYS.creditMonthlyAllotment,
      creditsConfig.monthlyAllotment,
    ),
  );

  // CU-868kjc7g5: sin denominador no hay porcentaje que signifique nada. Antes esto
  // dividía a ciegas: un allotment mal puesto a 0 desde el panel daba Infinity/NaN y la
  // comparación de abajo decidía en silencio. La causa raíz del ruido era otra —ninguna
  // empresa recibía créditos jamás, así que `balance` era estructuralmente 0 y la alerta
  // disparaba en cada evaluación desde el día uno— y se arregla con la asignación
  // inicial (`grantInitialCredits`); esto es la guarda que faltaba al lado.
  if (!Number.isFinite(monthlyAllotment) || monthlyAllotment <= 0) return null;

  const pctRemaining = (balance / monthlyAllotment) * 100;
  return pctRemaining < threshold ? { value: pctRemaining } : null;
}

const EVALUATORS: Record<
  string,
  (db: DB, companyId: string, threshold: number) => Promise<ResultadoDeRegla | null>
> = {
  ar_overdue: evalArOverdue,
  portfolio_concentration: evalPortfolioConcentration,
  revenue_drop: evalRevenueDrop,
  margin_drop: evalMarginDrop,
  spend_out_of_range: evalSpendOutOfRange,
  low_credit_balance: evalLowCreditBalance,
};

/**
 * CU-868kfvad3: motor determinista (sin IA), catálogo fijo, umbrales por empresa.
 * Llamado tras cada job de Excel exitoso (criterio 2). Historial completo en
 * alert_events (criterio 3) — incluso las que no notifican por el control de
 * repetición de 7 días (alert-catalog.ts), a diferencia de las que sí envían email.
 */
export async function evaluateAlerts(
  db: DB,
  companyId: string,
  documentId?: string,
): Promise<void> {
  const rules = await db
    .select()
    .from(alertRules)
    .where(and(eq(alertRules.companyId, companyId), eq(alertRules.enabled, true)));

  const [company] = await db
    .select({ locale: companies.locale })
    .from(companies)
    .where(eq(companies.id, companyId));
  const locale = company?.locale ?? 'es';

  for (const rule of rules) {
    const evaluator = EVALUATORS[rule.ruleKey];
    if (!evaluator) continue;

    const resultado = await evaluator(db, companyId, Number(rule.threshold));
    if (resultado === null) continue;

    const sevenDaysAgo = new Date(Date.now() - NO_REPEAT_DAYS * 86_400_000);
    const [recent] = await db
      .select({ id: alertEvents.id })
      .from(alertEvents)
      .where(
        and(
          eq(alertEvents.companyId, companyId),
          eq(alertEvents.alertRuleId, rule.id),
          gte(alertEvents.createdAt, sevenDaysAgo),
        ),
      )
      .limit(1);

    const [event] = await db
      .insert(alertEvents)
      .values({
        companyId,
        alertRuleId: rule.id,
        triggeredValue: String(resultado.value),
        // CU-868kt94an: qué mes se evaluó y contra qué. `undefined` en las reglas que no
        // miran un período (concentración, saldo) — Drizzle lo omite y la columna queda
        // NULL, que es lo correcto: no hay período que declarar, no se inventa uno.
        periodStart: resultado.periodStart,
        periodEnd: resultado.periodEnd,
        baselineValue: resultado.baseline === undefined ? undefined : String(resultado.baseline),
        documentId,
      })
      .returning();

    if (recent || !rule.notifyImmediately) continue; // suppressed by repeat window, or batched into the periodic report instead

    const catalogEntry = alertCatalog.find((c) => c.ruleKey === rule.ruleKey);
    const recipients = await db
      .select({ email: users.email })
      .from(companyUsers)
      .innerJoin(users, eq(users.id, companyUsers.userId))
      .where(
        and(
          eq(companyUsers.companyId, companyId),
          eq(companyUsers.status, 'active'),
          eq(companyUsers.receivesReports, true),
        ),
      );

    for (const recipient of recipients) {
      await sendAlertTriggeredEmail({
        companyId,
        locale,
        alertEventId: event!.id,
        ruleLabel: catalogEntry?.label ?? rule.ruleKey,
        recipientEmail: recipient.email,
        viewUrl: alertUrl(event!.id),
      });
    }
  }
}
