import { describe, expect, test } from 'bun:test';
import { LIBROS } from './hostiles/libros';
import { correrPipeline } from './hostiles/pipeline-doble';

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * DIEZ LIBROS MAL HECHOS CONTRA LA CIFRA DEL DASHBOARD
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *
 * `dashboard-e2e.test.ts` cubre los fallos que llegaron como reporte de un cliente. Este cubre
 * los que aparecen al revés: construyendo archivos MAL HECHOS a propósito —typos, columnas
 * corridas, montos escritos a mano, meses mal escritos— y midiendo si la cifra final sobrevive.
 *
 * Lo que se afirma es el TOTAL DEL DASHBOARD, no el veredicto de una etapa. Un test que
 * afirma "esta hoja se clasifica así" pasa en verde mientras dos filtros correctos juntos
 * vacían el libro, que es la clase de fallo de la que hay siete reportes.
 */

for (const fabricar of LIBROS) {
  const libro = fabricar();

  describe(`${libro.archivo} — ${libro.titulo}`, () => {
    const c = correrPipeline(libro);
    const detalle = () =>
      [...c.destino].map(([h, d]) => `  ${h} → ${d}`).join('\n') +
      (c.motivos.size ? `\n  marcadas: ${[...c.motivos].map(([m, n]) => `${m}×${n}`)}` : '');

    test('los ingresos son los del archivo', () => {
      expect(`revenue=${c.totales.revenue}\n${detalle()}`).toBe(
        `revenue=${libro.verdad.revenue}\n${detalle()}`,
      );
    });

    test('el costo de ventas es el del archivo', () => {
      expect(c.totales.cogs).toBeCloseTo(libro.verdad.cogs, 2);
    });

    test('los gastos operativos son los del archivo', () => {
      expect(c.totales.opex).toBeCloseTo(libro.verdad.opex, 2);
    });

    test('van a revisión exactamente las filas que no se pueden leer', () => {
      expect(`${c.marcadas} (${[...c.motivos]})`).toBe(`${libro.marcadas ?? 0} (${[...c.motivos]})`);
    });

    if (libro.destinos) {
      test('cada hoja termina donde debe', () => {
        for (const [hoja, esperado] of Object.entries(libro.destinos!)) {
          const real = c.destino.get(hoja) ?? '(no vista)';
          if (esperado instanceof RegExp) expect(`${hoja}: ${real}`).toMatch(esperado);
          else expect(`${hoja}: ${real}`).toBe(`${hoja}: ${esperado}`);
        }
      });
    }
  });
}
