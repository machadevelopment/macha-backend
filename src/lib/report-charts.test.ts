import { describe, expect, test } from 'bun:test';
import { svgBarrasDeCosto, svgTendencia, type PuntoDeTendencia } from '@/lib/report-charts';

/**
 * CU-868kt4ap8 — "incluir gráficas" en el reporte.
 *
 * Lo que se fija acá no es cómo se ve, es lo que NO puede pasar: que la figura mienta sobre
 * los datos, que reviente con los bordes que el ledger produce de verdad (un período sin
 * movimiento, un solo día) o que use el color de marca sobre un dato.
 */

const etiquetas = { entradas: 'Entradas', salidas: 'Salidas' };

const punto = (date: string, revenue: number, cogs = 0, opex = 0): PuntoDeTendencia => ({
  date,
  revenue,
  cogs,
  opex,
});

describe('svgTendencia', () => {
  test('con menos de dos puntos no dibuja nada', () => {
    // Una gráfica de un punto es una mancha: ocupa lo mismo que una útil y no muestra
    // tendencia alguna. El llamador omite la sección en vez de dejar un hueco.
    expect(svgTendencia([], etiquetas)).toBe('');
    expect(svgTendencia([punto('2026-07-01', 100)], etiquetas)).toBe('');
  });

  test('las dos series comparten escala', () => {
    /*
     * El sentido de la gráfica es COMPARAR lo que entra con lo que sale. Con escalas
     * independientes, un mes de gastos chicos se dibujaría igual de alto que uno de
     * ingresos grandes y la figura mentiría.
     *
     * Entradas 100/200 y salidas 50/50: la salida nunca puede alcanzar el techo, que lo
     * marca el 200 de las entradas.
     */
    const svg = svgTendencia(
      [punto('2026-07-01', 100, 50), punto('2026-07-02', 200, 50)],
      etiquetas,
    );
    const ys = [...svg.matchAll(/,(\d+(?:\.\d+)?)/g)].map((m) => Number(m[1]));
    // El punto más alto (y menor, porque el eje va invertido en SVG) pertenece al máximo de
    // entradas; ninguna salida puede estar por encima.
    expect(Math.min(...ys)).toBeCloseTo(8, 1);
  });

  test('un período entero en cero no divide entre cero: la línea va al piso', () => {
    // Pasa de verdad: una empresa cuyo Excel no llega al período elegido. La gráfica tiene
    // que salir plana abajo, no vacía ni con NaN dentro del atributo.
    const svg = svgTendencia([punto('2026-07-01', 0), punto('2026-07-02', 0)], etiquetas);
    expect(svg).not.toContain('NaN');
    expect(svg).toContain('polyline');
  });

  test('usa los colores FUNCIONALES, nunca el salvia de marca', () => {
    // Regla de los dos verdes: el salvia dice "esto es Macha" y no puede ir sobre un dato.
    const svg = svgTendencia([punto('2026-07-01', 100), punto('2026-07-02', 50)], etiquetas);
    expect(svg).toContain('#16A34A');
    expect(svg).toContain('#DC2626');
    expect(svg.toUpperCase()).not.toContain('A0AF9A');
  });

  test('las salidas suman costo directo y gasto operativo', () => {
    // Es como sale el dinero de la cuenta. Con 60+40 la salida iguala a la entrada de 100,
    // así que las dos líneas tienen que tocar el mismo techo.
    const svg = svgTendencia(
      [punto('2026-07-01', 100, 60, 40), punto('2026-07-02', 0, 0, 0)],
      etiquetas,
    );
    const alturas = [...svg.matchAll(/,(\d+(?:\.\d+)?)/g)].map((m) => Number(m[1]));
    expect(alturas.filter((v) => Math.abs(v - 8) < 0.5).length).toBeGreaterThanOrEqual(2);
  });
});

describe('svgBarrasDeCosto', () => {
  test('sin categorías con monto no dibuja nada', () => {
    expect(svgBarrasDeCosto([])).toBe('');
    expect(svgBarrasDeCosto([{ category: 'vacía', total: 0 }])).toBe('');
  });

  test('recorta a las primeras y no revienta con muchas', () => {
    // El desglose de un Excel real trae decenas de categorías; todas dibujadas serían una
    // figura de tres páginas que nadie lee.
    const muchas = Array.from({ length: 40 }, (_, i) => ({ category: `cat_${i}`, total: 100 - i }));
    const svg = svgBarrasDeCosto(muchas);
    expect((svg.match(/<rect/g) ?? []).length).toBe(6);
  });

  test('la barra más grande ocupa el ancho completo y las demás su proporción', () => {
    const svg = svgBarrasDeCosto([
      { category: 'grande', total: 100 },
      { category: 'mitad', total: 50 },
    ]);
    const anchos = [...svg.matchAll(/<rect[^>]*width="([\d.]+)"/g)].map((m) => Number(m[1]));
    expect(anchos[1]).toBeCloseTo(anchos[0]! / 2, 1);
  });

  test('escapa el nombre de la categoría, que viene del Excel del cliente', () => {
    // Es entrada de usuario dentro de un documento que se sirve como HTML.
    const svg = svgBarrasDeCosto([{ category: '<script>alert(1)</script>', total: 10 }]);
    expect(svg).not.toContain('<script>');
    expect(svg).toContain('&lt;script&gt;');
  });

  test('las barras van en tinta neutra, no en color de estado', () => {
    // Un desglose de costos es una composición, no un veredicto: pintar de rojo la categoría
    // más grande diría "esto está mal" sobre un gasto que puede ser el normal del negocio.
    const svg = svgBarrasDeCosto([{ category: 'materia prima', total: 10 }]);
    expect(svg).not.toContain('#DC2626');
    expect(svg).toContain('#1C1C1C');
  });
});
