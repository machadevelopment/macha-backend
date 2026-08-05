import { describe, expect, test } from 'bun:test';
import { grossProfit, grossMarginPct } from './margin';

/**
 * CU-868kh8y58. Lo que se fija aquí no es la aritmética (es una resta), es la
 * DEFINICIÓN: qué se resta y qué no. Si alguien más adelante mete `opex` en el
 * cálculo pensando que "margen" era neto, estos tests son lo que lo detiene.
 */
describe('margen bruto (CU-868kh8y58)', () => {
  test('utilidad bruta = ingresos - costo directo', () => {
    expect(grossProfit(100_000, 64_300)).toBe(35_700);
  });

  test('el porcentaje cuadra con la utilidad que lo acompaña', () => {
    // El par que se muestra junto en el dashboard: Q35,700 y 35.7%. Si estos dos
    // números salieran de fórmulas distintas, volvería el bug original.
    expect(grossProfit(100_000, 64_300)).toBe(35_700);
    expect(grossMarginPct(100_000, 64_300)).toBeCloseTo(35.7, 10);
  });

  test('opex NO entra: el gasto de estructura no toca el margen bruto', () => {
    // Mismo ingreso y mismo costo directo, con o sin gasto operativo, dan el mismo
    // margen bruto — el opex simplemente no es un parámetro de esta función.
    expect(grossMarginPct(100_000, 64_300)).toBeCloseTo(35.7, 10);
    expect(grossProfit(100_000, 64_300)).toBe(35_700);
  });

  test('sin ventas no hay margen: devuelve null, no 0', () => {
    // 0 haría que `margin_drop` (umbral 25%) se disparara todos los meses sin
    // facturación, que es justo cuando el dueño menos necesita ruido.
    expect(grossMarginPct(0, 0)).toBeNull();
    expect(grossMarginPct(0, 5_000)).toBeNull();
  });

  test('un período que vendió a pérdida da margen negativo, no null', () => {
    // Vender por debajo del costo es una señal real y tiene que llegar a la alerta.
    expect(grossProfit(10_000, 12_500)).toBe(-2_500);
    expect(grossMarginPct(10_000, 12_500)).toBeCloseTo(-25, 10);
  });
});
