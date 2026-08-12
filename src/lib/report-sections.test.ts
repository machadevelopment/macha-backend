import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_SECTIONS,
  REPORT_SECTIONS,
  fromStoredMetrics,
  normalizeSections,
  toStoredMetrics,
  type ReportData,
} from '@/lib/report-sections';

describe('catálogo de secciones', () => {
  /**
   * El test que fija la decisión del ticket B2, no un detalle de implementación.
   *
   * `cash_flow` era una de las secciones candidatas y quedó FUERA porque el dato no
   * existe: `transactions` no tiene fecha de cobro/pago, `invoices.status`/`bills.status`
   * nunca se mueven de 'open' en ningún camino del código, y `settled_transaction_id`
   * jamás se escribe. Si alguien la agrega al enum sin agregar antes el dato, este test
   * falla y lo obliga a explicar de dónde salen las cifras.
   */
  test('cash_flow NO es una sección: el dato de caja no existe en el modelo', () => {
    expect(REPORT_SECTIONS).not.toContain('cash_flow' as never);
  });

  test('todas las secciones del catálogo son distintas', () => {
    expect(new Set(REPORT_SECTIONS).size).toBe(REPORT_SECTIONS.length);
  });

  test('las secciones por defecto de cada tipo existen en el catálogo', () => {
    for (const secciones of Object.values(DEFAULT_SECTIONS)) {
      for (const s of secciones) expect(REPORT_SECTIONS).toContain(s);
    }
  });

  /**
   * El tick diario no manda secciones y cae en este juego. Que sea `kpis` +
   * `recommendations` es lo que mantiene su comportamiento idéntico al de antes del
   * ticket: métricas por SQL + narrativa con recomendaciones.
   */
  test('executive_summary por defecto reproduce el reporte automático de siempre', () => {
    expect(DEFAULT_SECTIONS.executive_summary).toEqual(['kpis', 'recommendations']);
  });
});

describe('normalizeSections', () => {
  test('descarta lo que no es una sección real', () => {
    expect(normalizeSections(['kpis', 'cash_flow', 'inventado'])).toEqual(['kpis']);
  });

  test('quita repetidas y devuelve el orden del catálogo, no el del cliente', () => {
    expect(normalizeSections(['risks', 'kpis', 'kpis'])).toEqual(['kpis', 'risks']);
  });

  test('sin nada válido devuelve vacío (el endpoint lo rechaza con 400)', () => {
    expect(normalizeSections(['cash_flow'])).toEqual([]);
  });
});

const DATOS: ReportData = {
  periodStart: '2026-07-01',
  periodEnd: '2026-07-31',
  reportType: 'executive_summary',
  sections: ['kpis', 'risks'],
  kpis: {
    revenue: 1000,
    cogs: 400,
    opex: 200,
    other: 0,
    grossProfit: 600,
    grossMarginPct: 60,
    margin: 600,
    accountsReceivableOpen: 50,
    accountsPayableOpen: 25,
  },
  risks: {
    alerts: [],
    agingAsOf: '2026-08-11',
    arAging: { current: 50, '1_30': 0, '31_60': 0, '61_90': 0, '90_plus': 0 },
    apAging: { current: 25, '1_30': 0, '31_60': 0, '61_90': 0, '90_plus': 0 },
  },
};

describe('persistencia en report_versions.metrics', () => {
  /**
   * `report_versions` es append-only: la forma con la que se guarda hoy es la que se
   * tendrá que poder leer para siempre. Los KPIs van APLANADOS en la raíz porque así los
   * guardó el primer reporte y así los lee el frontend (`metrics.revenue`).
   */
  test('los KPIs quedan en la raíz, no anidados bajo "kpis"', () => {
    const guardado = toStoredMetrics(DATOS);
    expect(guardado.revenue).toBe(1000);
    expect(guardado.grossMarginPct).toBe(60);
    expect(guardado.kpis).toBeUndefined();
  });

  test('las secciones nuevas van bajo su propia clave', () => {
    const guardado = toStoredMetrics(DATOS);
    expect(guardado.risks).toBeDefined();
    expect(guardado.sections).toEqual(['kpis', 'risks']);
  });

  test('ida y vuelta sin pérdida', () => {
    expect(fromStoredMetrics(toStoredMetrics(DATOS))).toEqual(DATOS);
  });

  /**
   * Una versión generada ANTES de este ticket guardó solo el objeto plano de KPIs, sin
   * `sections` ni `reportType`. Tiene que poder exportarse a PDF igual: si esto se rompe,
   * todo reporte anterior al despliegue deja de poder descargarse.
   */
  test('lee una versión anterior al ticket (sin sections ni reportType)', () => {
    const viejo = {
      periodStart: '2026-06-01',
      periodEnd: '2026-06-01',
      revenue: 10,
      cogs: 4,
      opex: 1,
      other: 0,
      grossProfit: 6,
      grossMarginPct: 60,
      margin: 6,
      accountsReceivableOpen: 0,
      accountsPayableOpen: 0,
    };
    const leido = fromStoredMetrics(viejo);
    expect(leido.reportType).toBe('executive_summary');
    expect(leido.sections).toEqual(['kpis', 'recommendations']);
    expect(leido.kpis?.revenue).toBe(10);
    expect(leido.risks).toBeUndefined();
  });

  test('un margen nulo (período sin ventas) sobrevive como null y no como 0', () => {
    const guardado = toStoredMetrics({
      ...DATOS,
      kpis: { ...DATOS.kpis!, revenue: 0, grossMarginPct: null },
    });
    expect(fromStoredMetrics(guardado).kpis?.grossMarginPct).toBeNull();
  });
});
