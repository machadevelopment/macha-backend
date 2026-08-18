import { describe, expect, test } from 'bun:test';
import { buildReportSystemPrompt } from '@/lib/report-prompt';

/**
 * CU-868kt4ap8, punto 2 — "en el resumen ejecutivo no sale el tipo de moneda ni el número
 * bien formateado".
 *
 * ═══ DÓNDE ESTABA, Y DÓNDE NO ═══
 *
 * El RENDER nunca tuvo el problema: `report-render.ts` pasa cada cifra por `formatMoney`
 * con la moneda base de la empresa, en HTML, en PDF y en Excel.
 *
 * El problema está en la NARRATIVA, que la escribe el modelo. El snapshot que recibe son
 * números pelados —ni un campo dice si son quetzales o dólares— así que las cifras que el
 * modelo menciona en la prosa salen como `12345.67`, sin símbolo y con decimales.
 *
 * Es exactamente el mismo hueco que CU-868krvtjw encontró en los insights, y se cierra con
 * la misma directiva. Los tests de `insight-directives.test.ts` cubren el contenido de esa
 * directiva; estos cubren que el prompt del REPORTE la lleve.
 */

const base = {
  locale: 'es' as const,
  reportType: 'executive_summary' as const,
  sections: ['kpis' as const],
};

describe('el prompt del reporte lleva la moneda', () => {
  test('nombra el símbolo y el código de la empresa', () => {
    const p = buildReportSystemPrompt({ ...base, baseCurrency: 'GTQ' });
    expect(p).toContain('Q');
    expect(p).toContain('GTQ');
  });

  test('una empresa en dólares NO recibe la instrucción de quetzales', () => {
    // El fallo silencioso: cifras correctas con la moneda equivocada se ven perfectamente
    // normales. Es el mismo riesgo que ya cubre el insight.
    const p = buildReportSystemPrompt({ ...base, baseCurrency: 'USD' });
    expect(p).toContain('$');
    expect(p).toContain('USD');
    expect(p).not.toContain('GTQ');
  });

  test('pide números sin decimales', () => {
    const p = buildReportSystemPrompt({ ...base, baseCurrency: 'GTQ' });
    expect(p).toMatch(/SIN decimales/);
  });

  test('sin moneda, el prompt queda como estaba', () => {
    // Opcional para no romper a los llamadores que no la pasan. Si algún día alguien
    // construye el prompt sin moneda, el reporte pierde el formato pero no falla.
    const p = buildReportSystemPrompt(base);
    expect(p).not.toContain('SIN decimales');
    expect(p.length).toBeGreaterThan(0);
  });
});

describe('la directiva va ANTES de las instrucciones del usuario', () => {
  test('el formato de moneda no es negociable por el usuario', () => {
    /*
     * El usuario puede pedir en qué poner el acento ("enfócate en la rentabilidad"); no
     * puede pedir cifras sin moneda. Poniendo la directiva antes, sus instrucciones quedan
     * como la última palabra sobre el ENFOQUE y no sobre el formato — que es lo que el
     * propio bloque de instrucciones ya dice: "NO cambia las cifras".
     */
    const p = buildReportSystemPrompt({
      ...base,
      baseCurrency: 'GTQ',
      instructions: 'escribe los montos como quieras',
    });
    expect(p.indexOf('SIN decimales')).toBeLessThan(p.indexOf('escribe los montos'));
  });
});
