import { describe, expect, test } from 'bun:test';
import { PDFDocument } from 'pdf-lib';
import * as XLSX from 'xlsx';
import {
  formatMoney,
  formatPct,
  renderReportHtml,
  renderReportPdf,
  renderReportXlsx,
  sanitizeWinAnsi,
  type RenderInput,
} from '@/lib/report-render';
import type { ReportData } from '@/lib/report-sections';

const DATOS_COMPLETOS: ReportData = {
  periodStart: '2026-07-01',
  periodEnd: '2026-07-31',
  reportType: 'executive_summary',
  sections: ['kpis', 'revenue_trend', 'cost_breakdown', 'top_products', 'risks', 'recommendations'],
  kpis: {
    revenue: 125000.5,
    cogs: 60000,
    opex: 20000,
    other: 0,
    grossProfit: 65000.5,
    grossMarginPct: 52,
    margin: 65000.5,
    accountsReceivableOpen: 18000,
    accountsPayableOpen: 9000,
  },
  revenueTrend: {
    current: { revenue: 125000.5, cogs: 60000, opex: 20000, other: 0 },
    previous: { revenue: 110000, cogs: 55000, opex: 19000, other: 0 },
    series: [{ date: '2026-07-01', revenue: 5000, cogs: 2000, opex: 800, other: 0 }],
  },
  costBreakdown: [
    { category: 'materia_prima', type: 'cogs', total: 60000, transactionCount: 12, sharePct: 100 },
    { category: 'planilla', type: 'opex', total: 20000, transactionCount: 4, sharePct: 100 },
  ],
  topProducts: [
    {
      productId: '00000000-0000-4000-8000-000000000001',
      name: 'Café molido — 1 lb',
      category: 'bebidas',
      revenue: 80000,
      cogs: 40000,
      grossProfit: 40000,
      grossMarginPct: 50,
      units: 1200,
      revenueWithUnits: 80000,
      transactionCount: 30,
      revenueSharePct: 64,
      previousRevenue: 70000,
      trend: 'up',
      costKnown: true,
    },
  ],
  risks: {
    alerts: [
      {
        ruleKey: 'ar_overdue',
        label: 'Cobro vencido',
        threshold: 60,
        triggeredValue: 74,
        unit: 'days',
        occurredAt: '2026-07-15T10:00:00.000Z',
      },
    ],
    agingAsOf: '2026-08-11',
    arAging: { current: 8000, '1_30': 4000, '31_60': 3000, '61_90': 2000, '90_plus': 1000 },
    apAging: { current: 9000, '1_30': 0, '31_60': 0, '61_90': 0, '90_plus': 0 },
  },
};

const ENTRADA: RenderInput = {
  companyName: 'Distribuidora Ñandú, S.A.',
  baseCurrency: 'GTQ',
  locale: 'es',
  data: DATOS_COMPLETOS,
  narrative: 'Las ventas subieron 14 % contra el mes anterior.\n\nEl margen se sostuvo.',
};

describe('formato de cifras', () => {
  /** La moneda SIEMPRE con su código: un PDF se imprime fuera de la app. */
  test('el monto lleva el código de moneda, no un símbolo suelto', () => {
    expect(formatMoney(1234.5, 'GTQ', 'es')).toContain('GTQ');
    expect(formatMoney(1234.5, 'USD', 'en')).toContain('USD');
  });

  test('un margen nulo se dice con palabras, no con un 0 %', () => {
    expect(formatPct(null, 'es')).toBe('sin ventas en el período');
    expect(formatPct(null, 'en')).toBe('no sales in period');
  });
});

describe('sanitizeWinAnsi', () => {
  /**
   * LA TRAMPA VERIFICADA de pdf-lib: las fuentes estándar codifican en WinAnsi y
   * `drawText` LANZA con lo que quede fuera. Una narrativa de IA o el nombre de un
   * producto salido del Excel del cliente pueden traer cualquier cosa.
   */
  test('los acentos y la puntuación española pasan intactos', () => {
    expect(sanitizeWinAnsi('Café · Ñandú · ¿Margen? ¡Sí! €')).toBe(
      'Café · Ñandú · ¿Margen? ¡Sí! €',
    );
  });

  test('traduce la puntuación tipográfica en vez de mutilarla', () => {
    expect(sanitizeWinAnsi('“hola” — sí…')).toBe('"hola" - sí...');
  });

  test('sustituye lo que WinAnsi no puede codificar', () => {
    expect(sanitizeWinAnsi('ventas 🚀 y 漢字')).toBe('ventas ? y ??');
  });

  test('conserva los saltos de línea, que es lo que pagina la narrativa', () => {
    expect(sanitizeWinAnsi('a\nb')).toBe('a\nb');
  });
});

describe('renderReportHtml', () => {
  test('incluye una sección por cada bloque de datos presente', () => {
    const html = renderReportHtml(ENTRADA);
    expect(html).toContain('Indicadores del período');
    expect(html).toContain('Evolución de ingresos');
    expect(html).toContain('Desglose de costos');
    expect(html).toContain('Productos principales');
    expect(html).toContain('Riesgos');
  });

  /** El corazón del ticket: menos secciones = menos reporte, no el mismo reporte. */
  test('omite las secciones que no se calcularon', () => {
    const html = renderReportHtml({
      ...ENTRADA,
      data: {
        periodStart: '2026-07-01',
        periodEnd: '2026-07-31',
        reportType: 'executive_summary',
        sections: ['kpis'],
        kpis: DATOS_COMPLETOS.kpis,
      },
    });
    expect(html).toContain('Indicadores del período');
    expect(html).not.toContain('Productos principales');
    expect(html).not.toContain('Desglose de costos');
  });

  test('escapa el contenido: un nombre de producto no puede inyectar markup', () => {
    const html = renderReportHtml({
      ...ENTRADA,
      companyName: '<script>alert(1)</script>',
    });
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  test('dice explícitamente cuándo una sección vino vacía en vez de callarla', () => {
    const html = renderReportHtml({
      ...ENTRADA,
      data: { ...DATOS_COMPLETOS, topProducts: [] },
    });
    expect(html).toContain('no identificó productos');
  });
});

describe('renderReportPdf', () => {
  test('produce un PDF válido bajo Bun', async () => {
    const bytes = await renderReportPdf(ENTRADA);
    expect(bytes.length).toBeGreaterThan(1000);
    expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe('%PDF-');
  });

  /**
   * La regresión que de verdad importa: sin `sanitizeWinAnsi` esto lanza
   * `WinAnsi cannot encode` y el cliente no puede exportar su reporte.
   */
  test('no revienta con emojis ni CJK en la narrativa', async () => {
    const bytes = await renderReportPdf({
      ...ENTRADA,
      narrative: 'Ventas 🚀 en 東京 — “excelente” mes…',
      companyName: 'Ñandú 🚀',
    });
    expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe('%PDF-');
  });

  test('exporta también un reporte de una sola sección', async () => {
    const bytes = await renderReportPdf({
      ...ENTRADA,
      data: {
        periodStart: '2026-07-01',
        periodEnd: '2026-07-31',
        reportType: 'executive_summary',
        sections: ['kpis'],
        kpis: DATOS_COMPLETOS.kpis,
      },
    });
    expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe('%PDF-');
  });

  /** Un rango largo con muchas filas tiene que paginar, no dibujar fuera de la página. */
  test('pagina cuando el contenido no cabe en una hoja', async () => {
    const muchos = Array.from({ length: 120 }, (_, i) => ({
      category: `categoria_${i}`,
      type: 'opex' as const,
      total: i * 100,
      transactionCount: i,
      sharePct: 1,
    }));
    const bytes = await renderReportPdf({
      ...ENTRADA,
      data: { ...DATOS_COMPLETOS, costBreakdown: muchos },
    });
    const cargado = await PDFDocument.load(bytes);
    expect(cargado.getPageCount()).toBeGreaterThan(1);
  });
});

describe('renderReportXlsx', () => {
  test('produce un libro legible con la hoja de resumen consolidado', () => {
    const buf = renderReportXlsx(ENTRADA);
    const wb = XLSX.read(buf, { type: 'buffer' });
    expect(wb.SheetNames[0]).toBe('Resumen');
    expect(wb.SheetNames).toContain('Productos');
    expect(wb.SheetNames).toContain('Costos');
  });

  /**
   * El requisito literal del ticket: ventas, gastos, utilidad y margen. Y como NÚMEROS —
   * un Excel cuyas celdas no suman no sirve para lo único que se pide un Excel.
   */
  test('el resumen trae ventas, gastos, utilidad y margen como números', () => {
    const buf = renderReportXlsx(ENTRADA);
    const wb = XLSX.read(buf, { type: 'buffer' });
    const filas = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets.Resumen!, { header: 1 });
    const buscar = (etiqueta: string) =>
      filas.find((f) => String(f[0] ?? '').startsWith(etiqueta))?.[1];

    expect(buscar('Ventas')).toBe(125000.5);
    expect(buscar('Gastos')).toBe(80000); // costo directo + gasto operativo
    expect(buscar('Utilidad bruta')).toBe(65000.5);
    // El margen va como fracción para que Excel lo formatee como porcentaje.
    expect(buscar('Margen bruto')).toBeCloseTo(0.52, 6);
  });

  test('sin sección de indicadores lo dice, no inventa un resumen en cero', () => {
    const buf = renderReportXlsx({
      ...ENTRADA,
      data: {
        periodStart: '2026-07-01',
        periodEnd: '2026-07-31',
        reportType: 'executive_summary',
        sections: ['risks'],
        risks: DATOS_COMPLETOS.risks,
      },
    });
    const wb = XLSX.read(buf, { type: 'buffer' });
    const filas = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets.Resumen!, { header: 1 });
    expect(JSON.stringify(filas)).toContain('no incluyó la sección de indicadores');
    expect(wb.SheetNames).not.toContain('Productos');
  });
});
