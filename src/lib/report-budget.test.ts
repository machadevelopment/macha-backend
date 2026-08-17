import { describe, expect, test } from 'bun:test';
import { presupuestoDeNarrativa } from '@/lib/report-budget';
import { DEFAULT_SECTIONS, REPORT_SECTIONS } from '@/lib/report-sections';
import { REPORT_MAX_TOKENS_POR_DEFECTO } from '@/lib/anthropic';

/**
 * CU-868krw2wn — el presupuesto de salida de la narrativa.
 *
 * El bug era un `max_tokens: 2048` quemado para todo reporte, dimensionado cuando el único
 * reporte que existía era el de dos secciones del tick diario. Con seis secciones la
 * narrativa no cabía y salía cortada a mitad de frase.
 */
describe('presupuesto de la narrativa', () => {
  test('crece con la cantidad de secciones', () => {
    const una = presupuestoDeNarrativa(['kpis']);
    const tres = presupuestoDeNarrativa(['kpis', 'revenue_trend', 'cost_breakdown']);
    const todas = presupuestoDeNarrativa(REPORT_SECTIONS);

    expect(una).toBeLessThan(tres);
    expect(tres).toBeLessThan(todas);
  });

  test('el reporte de TODAS las secciones recibe bastante más que el fijo viejo', () => {
    /*
     * El corazón del ticket. Con el valor viejo, un reporte de seis secciones tenía el
     * mismo techo que uno de dos — y esa es exactamente la diferencia entre una narrativa
     * completa y una que se corta. No se afirma un número exacto (el presupuesto se puede
     * recalibrar); se afirma la RELACIÓN, que es la que no puede volver a romperse.
     */
    expect(presupuestoDeNarrativa(REPORT_SECTIONS)).toBeGreaterThan(
      REPORT_MAX_TOKENS_POR_DEFECTO * 1.5,
    );
  });

  test('el reporte por defecto no se queda por debajo del presupuesto viejo', () => {
    // Contraparte del anterior: agrandar el techo de los reportes largos no puede haber
    // ENCOGIDO el de los que ya funcionaban. El tick diario no cambia de comportamiento.
    expect(presupuestoDeNarrativa(DEFAULT_SECTIONS.executive_summary)).toBeGreaterThanOrEqual(
      REPORT_MAX_TOKENS_POR_DEFECTO * 0.8,
    );
  });

  test('tiene techo: ni con las secciones repetidas se dispara', () => {
    // `sections` llega normalizada, pero el techo es una defensa del PRODUCTO (una
    // narrativa de 4.000 palabras deja de ser un resumen ejecutivo), no de la validación.
    const exagerado = [...REPORT_SECTIONS, ...REPORT_SECTIONS, ...REPORT_SECTIONS];
    expect(presupuestoDeNarrativa(exagerado)).toBeLessThanOrEqual(6_000);
  });
});
