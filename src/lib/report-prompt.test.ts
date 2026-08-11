import { describe, expect, test } from 'bun:test';
import {
  MAX_INSTRUCTIONS_LENGTH,
  buildReportSystemPrompt,
  sanitizeInstructions,
} from '@/lib/report-prompt';

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
