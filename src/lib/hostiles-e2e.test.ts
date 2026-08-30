import { describe, expect, test } from 'bun:test';
import { LIBROS, libroInventarioAislado } from './hostiles/libros';
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

/* ═══════════════════════════════════════════════════════════════════════════════════════════
 * EL HUECO QUE NO SE CERRÓ, FIJADO CON SU CIFRA
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *
 * Un test que afirma un comportamiento INCORRECTO es raro y acá está justificado: el hueco es
 * real, está medido, y el arreglo que lo cierra no es seguro. Dejarlo sin test lo volvería
 * invisible; dejarlo en rojo haría que la suite dejara de significar algo.
 *
 * ═══ QUÉ FALLA ═══
 *
 * Un inventario serializado (VIN, matrícula, número de serie) solo se reconoce como tabla de
 * entidades si OTRA hoja del libro lo referencia. Cuando la facturación no nombra el VIN —que
 * es lo normal si el vendedor factura por cliente y no por unidad— nada lo apunta, la hoja se
 * va al modelo, y el modelo hace lo único que puede con `Costo Adquisicion`: registrarlo como
 * gasto. Medido acá: **Q 1.864.500** de egreso que nadie desembolsó en el período.
 *
 * ═══ POR QUÉ NO SE ARREGLÓ ═══
 *
 * El arreglo natural es dejar de exigir la referencia: una hoja con clave única por fila, que
 * no apunta a nadie y a la que nadie apunta, es un catálogo. Se implementó y **se revirtió**,
 * porque un test que ya existía en `sheet-relations.test.ts` es el contraejemplo exacto —
 * `Ventas` (`ID Venta · Monto`) y `Gastos` (`ID Gasto · Monto`) cumplen las tres condiciones y
 * pasarían a INVENTARIO. El veto por contraparte no salva a una hoja de mostrador que no
 * nombra al cliente, y perder la contabilidad de un cliente en silencio es peor que mostrarle
 * un gasto de más, que al menos se ve.
 *
 * Cuando aparezca un archivo real así, el camino es una firma de EXISTENCIAS SERIALIZADAS
 * (clave única + atributos del artículo + costo + sin columna de cantidad), no aflojar el
 * esquema del libro.
 */
describe('HUECO CONOCIDO: inventario que nadie referencia', () => {
  const libro = libroInventarioAislado();
  const c = correrPipeline(libro);

  test('los ingresos SÍ son los correctos: el hueco no los toca', () => {
    expect(c.totales.revenue).toBeCloseTo(libro.verdad.revenue, 2);
  });

  test('los 15 vehículos en stock entran como gasto — cifra fijada, no aprobada', () => {
    let stock = 0;
    for (let i = 0; i < 15; i++) stock += 118_000 + i * 900;
    expect(c.totales.opex).toBeCloseTo(stock, 2);
    // Si algún día esto falla porque `opex` da 0, el hueco se cerró: borrar este bloque.
    expect(c.destino.get('Inventario')).toBe('movimientos:15');
  });
});
