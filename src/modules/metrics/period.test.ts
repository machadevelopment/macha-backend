import { describe, expect, test } from 'bun:test';

process.env.DATABASE_URL ??= 'postgres://smoke:smoke@localhost:5432/smoke';

const { ventanaAnterior } = await import('./period');

/**
 * La comparación del filtro de período. Es la parte con más forma de trampa: el delta
 * que muestra cada tarjeta ("+11.4% vs. anterior") depende enteramente de contra qué
 * ventana se compara, y equivocarla no rompe nada — solo miente.
 */
describe('ventanaAnterior (filtro de período)', () => {
  test('un mes completo compara contra el mes anterior completo', () => {
    // Agosto tiene 31 días, así que la ventana previa es julio completo.
    expect(ventanaAnterior('2026-08-01', '2026-08-31')).toEqual({
      from: '2026-07-01',
      to: '2026-07-31',
    });
  });

  test('la ventana anterior tiene EXACTAMENTE la misma cantidad de días', () => {
    // La regla no es "el mes pasado", es "el mismo tamaño, justo antes". Comparar 12
    // días contra un mes entero daría un delta sin sentido que además se leería como
    // una caída enorme.
    const casos: Array<[string, string]> = [
      ['2026-08-06', '2026-08-06'], // un solo día
      ['2026-08-03', '2026-08-09'], // una semana
      ['2026-01-01', '2026-12-31'], // un año
      ['2026-03-05', '2026-03-17'], // rango arbitrario
    ];
    for (const [from, to] of casos) {
      const previa = ventanaAnterior(from, to);
      const dias = (a: string, b: string) =>
        Math.round(
          (new Date(`${b}T00:00:00Z`).getTime() - new Date(`${a}T00:00:00Z`).getTime()) /
            86_400_000,
        ) + 1;
      expect(dias(previa.from, previa.to)).toBe(dias(from, to));
    }
  });

  test('la ventana anterior termina el día ANTES de que empiece la actual', () => {
    // Sin esto se solaparían y el mismo día contaría en las dos mitades del delta.
    const previa = ventanaAnterior('2026-08-01', '2026-08-31');
    expect(previa.to).toBe('2026-07-31');
  });

  test('un solo día compara contra el día anterior', () => {
    expect(ventanaAnterior('2026-08-06', '2026-08-06')).toEqual({
      from: '2026-08-05',
      to: '2026-08-05',
    });
  });

  test('cruza el cambio de año sin romperse', () => {
    expect(ventanaAnterior('2026-01-01', '2026-01-07')).toEqual({
      from: '2025-12-25',
      to: '2025-12-31',
    });
  });
});
