import { describe, expect, test } from 'bun:test';
import {
  MAX_INSTRUCTIONS_LENGTH,
  buildReportSystemPrompt,
  sanitizeInstructions,
} from '@/lib/report-prompt';
import { DEFAULT_SECTIONS, REPORT_TYPES } from '@/lib/report-sections';

describe('buildReportSystemPrompt', () => {
  /**
   * El eje del ticket: las secciones modulan lo que se le PIDE a la IA, no solo lo que se
   * calcula. Un reporte de solo KPIs no debe llevar la instrucción de comentar productos
   * — es el camino por el que un modelo termina narrando datos que no vienen.
   */
  test('solo incluye las directivas de las secciones pedidas', () => {
    const prompt = buildReportSystemPrompt({
      locale: 'es',
      reportType: 'executive_summary',
      sections: ['kpis'],
    });
    expect(prompt).toContain('"kpis"');
    expect(prompt).not.toContain('topProducts');
    expect(prompt).not.toContain('costBreakdown');
  });

  test('con más secciones aparecen sus directivas, numeradas en orden', () => {
    const prompt = buildReportSystemPrompt({
      locale: 'es',
      reportType: 'executive_summary',
      sections: ['kpis', 'top_products', 'recommendations'],
    });
    expect(prompt).toContain('1. ');
    expect(prompt).toContain('2. ');
    expect(prompt).toContain('3. ');
    expect(prompt).toContain('topProducts');
    expect(prompt.indexOf('"kpis"')).toBeLessThan(prompt.indexOf('topProducts'));
  });

  test('respeta el idioma de la empresa', () => {
    const en = buildReportSystemPrompt({
      locale: 'en',
      reportType: 'executive_summary',
      sections: ['kpis'],
    });
    expect(en).toContain('in English');
    expect(en).not.toContain('en español');
  });

  /** La regla no negociable "la IA narra, nunca calcula" viaja en todo prompt. */
  test('siempre prohíbe inventar o recalcular cifras', () => {
    for (const locale of ['es', 'en'] as const) {
      const prompt = buildReportSystemPrompt({
        locale,
        reportType: 'executive_summary',
        sections: ['kpis'],
      });
      expect(prompt).toMatch(/NUNCA inventes|NEVER invent/);
    }
  });

  test('las instrucciones del usuario van delimitadas y acotadas en su alcance', () => {
    const prompt = buildReportSystemPrompt({
      locale: 'es',
      reportType: 'executive_summary',
      sections: ['kpis'],
      instructions: 'Enfócate en el margen',
    });
    expect(prompt).toContain('<<<\nEnfócate en el margen\n>>>');
    expect(prompt).toContain('NO cambia las cifras');
  });

  test('sin instrucciones no se agrega el bloque vacío', () => {
    const prompt = buildReportSystemPrompt({
      locale: 'es',
      reportType: 'executive_summary',
      sections: ['kpis'],
      instructions: '   ',
    });
    expect(prompt).not.toContain('<<<');
  });
});

describe('sanitizeInstructions', () => {
  test('recorta al tope y no más', () => {
    const limpio = sanitizeInstructions('a'.repeat(MAX_INSTRUCTIONS_LENGTH + 200));
    expect(limpio.length).toBe(MAX_INSTRUCTIONS_LENGTH);
  });

  test('quita caracteres de control, que es con lo que se falsifica un separador', () => {
    const conControl = `foo${String.fromCharCode(1)}bar`;
    expect(sanitizeInstructions(conControl)).toBe('foo bar');
  });

  test('colapsa las rachas de saltos de línea', () => {
    expect(sanitizeInstructions('a\n\n\n\n\nb')).toBe('a\n\nb');
  });

  test('normaliza CRLF', () => {
    expect(sanitizeInstructions('a\r\nb')).toBe('a\nb');
  });
});

/**
 * CU-868ku9rpy — cuatro tipos de reporte, y cada uno tiene que decir algo distinto.
 *
 * El prototipo ofrece seis tipos y el backend definía uno. Al agregar los tres que SÍ se
 * pueden construir con las secciones que ya existen, apareció el riesgo real: cuatro tipos
 * que comparten la sección de KPIs producirían cuatro narrativas indistinguibles, y el
 * selector de tipo quedaría decorativo. Lo que lo evita es la intro por tipo.
 */
describe('los cuatro tipos piden narrativas distintas (CU-868ku9rpy)', () => {
  const base = { locale: 'es' as const, sections: [] };

  test('cada tipo mete su propia instrucción en el prompt', () => {
    const intros = REPORT_TYPES.map((reportType) =>
      buildReportSystemPrompt({ ...base, reportType }),
    );

    // Ninguno repite el prompt de otro: si dos coincidieran, el tipo no cambiaría nada.
    expect(new Set(intros).size).toBe(REPORT_TYPES.length);
  });

  test('el de costos habla de gasto y acota el papel de los ingresos', () => {
    const p = buildReportSystemPrompt({ ...base, reportType: 'cost_analysis' });
    expect(p).toMatch(/COSTOS Y GASTOS/);
    // El matiz que importa: los ingresos son la referencia para pesar el gasto, no el tema.
    expect(p).toMatch(/no como tema/);
  });

  test('el de ventas manda decir cuándo NO hay productos, en vez de callarse', () => {
    /*
     * `top_products` viene vacía cuando el Excel del cliente no traía producto por fila —
     * el caso normal, no la excepción. Sin esta instrucción el modelo se calla y el usuario
     * lee un reporte de ventas sin ventas por producto, sin saber por qué.
     */
    const p = buildReportSystemPrompt({ ...base, reportType: 'sales_performance' });
    expect(p).toMatch(/vac[ií]a/i);
  });

  test('cada tipo trae un juego de secciones por defecto que no está vacío', () => {
    for (const tipo of REPORT_TYPES) {
      expect(DEFAULT_SECTIONS[tipo].length).toBeGreaterThan(0);
      // `kpis` va en los cuatro: es el ancla de cualquier reporte financiero.
      expect(DEFAULT_SECTIONS[tipo]).toContain('kpis');
    }
  });
});
