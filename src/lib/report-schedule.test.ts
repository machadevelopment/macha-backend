import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_REPORT_FREQUENCY,
  planScheduledReports,
  REPORT_FREQUENCIES,
  type CompanyReportPreference,
} from './report-schedule';

/**
 * CU-868kjc7t0, criterio 5: las tres frecuencias EN EL MISMO DÍA, comprobando exactamente
 * cuáles se encolan. Antes de este ticket el tick encolaba a las tres por igual, todos los
 * días.
 */
describe('planScheduledReports (CU-868kjc7t0 — frecuencia por empresa)', () => {
  const empresas: CompanyReportPreference[] = [
    { id: 'c-diaria', reportFrequency: 'daily' },
    { id: 'c-semanal', reportFrequency: 'weekly' },
    { id: 'c-apagada', reportFrequency: 'off' },
  ];

  // Martes 2026-08-11 y lunes 2026-08-17, ambos a las 06:00 UTC (hora real del cron).
  const martes = new Date('2026-08-11T06:00:00Z');
  const lunes = new Date('2026-08-17T06:00:00Z');

  test('un día cualquiera solo encola las diarias', () => {
    expect(planScheduledReports(empresas, martes)).toEqual([
      {
        companyId: 'c-diaria',
        periodStart: '2026-08-10',
        periodEnd: '2026-08-10',
        frequency: 'daily',
      },
    ]);
  });

  test('el lunes encola diarias y semanales, cada una con su propio período', () => {
    expect(planScheduledReports(empresas, lunes)).toEqual([
      {
        companyId: 'c-diaria',
        periodStart: '2026-08-16',
        periodEnd: '2026-08-16',
        frequency: 'daily',
      },
      // Semana calendario anterior completa: lunes 10 a domingo 16.
      {
        companyId: 'c-semanal',
        periodStart: '2026-08-10',
        periodEnd: '2026-08-16',
        frequency: 'weekly',
      },
    ]);
  });

  test('`off` no encola nada ningún día de la semana', () => {
    const apagada: CompanyReportPreference[] = [{ id: 'c-apagada', reportFrequency: 'off' }];
    for (let dia = 10; dia <= 16; dia++) {
      const fecha = new Date(`2026-08-${dia}T06:00:00Z`);
      expect(planScheduledReports(apagada, fecha)).toEqual([]);
    }
  });

  test('el período semanal cierra en el día anterior a la corrida, nunca en el día en curso', () => {
    const [job] = planScheduledReports([{ id: 'c', reportFrequency: 'weekly' }], lunes);
    expect(job).toBeDefined();
    expect(job!.periodEnd).toBe('2026-08-16');
    expect(job!.periodEnd < lunes.toISOString().slice(0, 10)).toBe(true);
  });

  test('cruza el fin de mes sin producir fechas inválidas', () => {
    // Lunes 2026-06-01: la semana anterior es 2026-05-25 .. 2026-05-31.
    const primeroDeJunio = new Date('2026-06-01T06:00:00Z');
    expect(primeroDeJunio.getUTCDay()).toBe(1);
    expect(planScheduledReports([{ id: 'c', reportFrequency: 'weekly' }], primeroDeJunio)).toEqual([
      {
        companyId: 'c',
        periodStart: '2026-05-25',
        periodEnd: '2026-05-31',
        frequency: 'weekly',
      },
    ]);
  });

  test('una frecuencia no reconocida se trata como `off`, no como el default', () => {
    const corrupta = [
      { id: 'c-rara', reportFrequency: 'mensual' },
    ] as unknown as CompanyReportPreference[];
    expect(planScheduledReports(corrupta, lunes)).toEqual([]);
  });

  test('el default es `weekly` y pertenece al catálogo', () => {
    expect(DEFAULT_REPORT_FREQUENCY).toBe('weekly');
    expect(REPORT_FREQUENCIES).toContain(DEFAULT_REPORT_FREQUENCY);
  });
});
