import { describe, expect, test, beforeAll, afterAll } from 'bun:test';
import { drizzle } from 'drizzle-orm/postgres-js';
import { ownerConnection, setupTestDatabase } from './setup';
import * as schema from '@/db/schema';
import { evaluateAlerts } from '@/lib/alerts';
import type { DB } from '@/db/client';

/**
 * CU-868kt94an: "caída de ingresos" contra un Postgres real.
 *
 * Esta regla no se puede probar con un test unitario: vive en dos agregaciones SQL y en
 * un INSERT, no en lógica de JavaScript. Y es justo el tipo de fallo que no se ve —
 * producía un número CORRECTO para una ventana de tiempo que nadie declaraba, así que
 * parecía un dato y era ruido. En producción, 18 de las 25 alertas de esta regla
 * marcaban exactamente 100 %.
 *
 * Los tres casos de abajo son los tres que se observaron, no casos inventados:
 * el mes a medio transcurrir (el reporte original), la caída real de un mes cerrado
 * (que NO se debe silenciar al arreglar lo anterior) y el mes sin cargar (las 18).
 *
 * Los meses se siembran relativos al reloj porque la regla misma es relativa al reloj:
 * fijarlos a 2019 haría que el test no probara nada.
 */

const COMPANY_ORG = 'org_alertas_periodo';

/** Primer día del mes, `monthsAgo` meses atrás — el mismo cálculo que `lib/alerts.ts`. */
function inicioDeMes(monthsAgo: number): string {
  const d = new Date();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() - monthsAgo);
  return d.toISOString().slice(0, 10);
}

describe('caída de ingresos: qué mes se evalúa (CU-868kt94an)', () => {
  let owner: ReturnType<typeof ownerConnection>;
  let db: DB;
  let companyId: string;
  let documentId: string;
  let reglaId: string;

  beforeAll(async () => {
    await setupTestDatabase();
    owner = ownerConnection();
    db = drizzle(owner, { schema }) as unknown as DB;

    const [c] = await owner`
      insert into companies (workos_org_id, name, industry)
      values (${COMPANY_ORG}, 'Alertas Periodo SA', 'retail') returning id
    `;
    companyId = c!.id;

    const suffix = companyId.replace(/-/g, '_');
    await owner.unsafe(
      `create table if not exists "transactions_${suffix}" partition of transactions
         for values in ('${companyId}')`,
    );

    const [u] = await owner`
      insert into users (workos_user_id, email)
      values ('wos_alertas_periodo', 'alertas.periodo@test.local') returning id
    `;
    const [d] = await owner`
      insert into documents (company_id, uploaded_by, s3_key, original_filename,
                             file_size_bytes, mime_type)
      values (${companyId}, ${u!.id}, ${`${companyId}/a`}, 'a.xlsx', 100, 'text/csv')
      returning id
    `;
    documentId = d!.id;

    // Solo esta regla habilitada: el resto del catálogo metería eventos que no se están
    // probando y volvería ambigua cualquier aserción sobre "la alerta que se disparó".
    const [r] = await owner`
      insert into alert_rules (company_id, rule_key, threshold, enabled, notify_immediately)
      values (${companyId}, 'revenue_drop', 15, true, false) returning id
    `;
    reglaId = r!.id;
  });

  afterAll(async () => {
    await owner.end();
  });

  async function sembrarIngreso(period: string, amount: number): Promise<void> {
    await owner`
      insert into transactions (company_id, document_id, date, type, category,
                                original_amount, original_currency, amount_base,
                                fx_rate, fx_rate_date)
      values (${companyId}, ${documentId}, ${period}, 'revenue', 'test',
              ${amount}, 'GTQ', ${amount}, 1, ${period})
    `;
  }

  async function limpiar(): Promise<void> {
    await owner`delete from alert_events where company_id = ${companyId}`;
    await owner`delete from metric_rollups where company_id = ${companyId}`;
    await owner.unsafe(`delete from transactions where company_id = '${companyId}'`);
  }

  async function eventos(): Promise<
    Array<{
      triggered_value: string;
      period_start: string | null;
      period_end: string | null;
      baseline_value: string | null;
    }>
  > {
    return (await owner`
      select triggered_value, period_start, period_end, baseline_value
      from alert_events where company_id = ${companyId} and alert_rule_id = ${reglaId}
    `) as never;
  }

  test('un mes EN CURSO a medio transcurrir no dispara la alerta', async () => {
    // El caso exacto del reporte: tres meses cerrados sanos y un mes en curso que va a la
    // mitad. La regla vieja comparaba diecisiete días contra tres meses enteros y cantaba
    // una caída del 52 % que no existía — la empresa iba a cerrar el mes plana.
    await limpiar();
    await sembrarIngreso(inicioDeMes(1), 2000);
    await sembrarIngreso(inicioDeMes(2), 2000);
    await sembrarIngreso(inicioDeMes(3), 2000);
    await sembrarIngreso(inicioDeMes(4), 2000);
    await sembrarIngreso(inicioDeMes(0), 300); // mes en curso, apenas empezado

    await evaluateAlerts(db, companyId, documentId);

    expect(await eventos()).toHaveLength(0);
  });

  test('una caída real en el último mes CERRADO sí dispara, con período y línea base', async () => {
    // Arreglar el falso positivo no puede costar la señal verdadera. Aquí el último mes
    // cerrado cae de 2.000 a 1.000: 50 %, muy por encima del umbral de 15 %.
    await limpiar();
    await sembrarIngreso(inicioDeMes(1), 1000);
    await sembrarIngreso(inicioDeMes(2), 2000);
    await sembrarIngreso(inicioDeMes(3), 2000);
    await sembrarIngreso(inicioDeMes(4), 2000);

    await evaluateAlerts(db, companyId, documentId);

    const filas = await eventos();
    expect(filas).toHaveLength(1);
    expect(Number(filas[0]!.triggered_value)).toBeCloseTo(50, 4);

    // Lo que el ticket vino a arreglar: la alerta declara de qué mes habla y contra qué
    // se comparó. Sin esto el asesor recalcula por su cuenta y sale un tercer número.
    expect(filas[0]!.period_start).toBe(inicioDeMes(1));
    expect(Number(filas[0]!.baseline_value)).toBeCloseTo(2000, 4);

    // `period_end` es el ÚLTIMO día de ese mes, no el primero del siguiente: si se
    // desbordara, el rango incluiría un día que no se evaluó.
    const finEsperado = new Date(inicioDeMes(0));
    finEsperado.setUTCDate(0);
    expect(filas[0]!.period_end).toBe(finEsperado.toISOString().slice(0, 10));
  });

  test('un mes sin cargar no es una caída del 100 %', async () => {
    // Las 18 de 25. En la primera carga el cliente sube su histórico hasta el mes pasado;
    // si el mes evaluado no tiene NINGÚN movimiento es que no se cargó, no que dejó de
    // vender, y la primera alerta de su vida no puede ser "caíste 100 %".
    await limpiar();
    await sembrarIngreso(inicioDeMes(2), 2000);
    await sembrarIngreso(inicioDeMes(3), 2000);
    await sembrarIngreso(inicioDeMes(4), 2000);
    // inicioDeMes(1) queda deliberadamente vacío.

    await evaluateAlerts(db, companyId, documentId);

    expect(await eventos()).toHaveLength(0);
  });

  test('un mes con gastos pero sin ingresos SÍ es una caída del 100 %', async () => {
    // El reverso del caso anterior, y la razón de que la comprobación mire "¿hay algún
    // movimiento?" y no "¿hay ingresos?": si hay datos del mes y los ingresos son cero,
    // eso es una caída real y hay que avisarla.
    await limpiar();
    await sembrarIngreso(inicioDeMes(2), 2000);
    await sembrarIngreso(inicioDeMes(3), 2000);
    await sembrarIngreso(inicioDeMes(4), 2000);
    await owner`
      insert into transactions (company_id, document_id, date, type, category,
                                original_amount, original_currency, amount_base,
                                fx_rate, fx_rate_date)
      values (${companyId}, ${documentId}, ${inicioDeMes(1)}, 'opex', 'test',
              500, 'GTQ', 500, 1, ${inicioDeMes(1)})
    `;

    await evaluateAlerts(db, companyId, documentId);

    const filas = await eventos();
    expect(filas).toHaveLength(1);
    expect(Number(filas[0]!.triggered_value)).toBeCloseTo(100, 4);
  });
});
