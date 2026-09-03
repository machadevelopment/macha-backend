import { describe, expect, test } from 'bun:test';
import { LIBROS, libroInventarioAislado } from './hostiles/libros';
import { libroElInfierno } from './hostiles/libro-el-infierno';
import { libroLaJoyeria } from './hostiles/libro-la-joyeria';
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

for (const fabricar of [...LIBROS, libroLaJoyeria]) {
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
      expect(`${c.marcadas} (${[...c.motivos]})`).toBe(
        `${libro.marcadas ?? 0} (${[...c.motivos]})`,
      );
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

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * EL INFIERNO: TODAS LAS TRAMPAS EN UN SOLO CUADERNO
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *
 * Diecisiete hojas y solo siete producen movimientos. Se afirma HOJA POR HOJA y no solo el
 * total, porque el total se deja engañar: dos errores de signo opuesto se cancelan y el libro
 * parece correcto — que es la forma exacta de los fallos de composición de esta ingesta.
 *
 * Este libro encontró CUATRO defectos reales el día que se escribió (2026-09-01), y los cuatro
 * están arreglados:
 *
 *  1. `Ventas` se descartaba ENTERA. Ocho movimientos buenos en cuatro formatos de fecha, más
 *     una fecha imposible, un TOTAL y un pie de página, daban 9/12 = 75 % de cobertura contra
 *     el 80 % que exige el filtro de supervivencia. Las dos suciedades más comunes de un Excel
 *     hecho a mano restaban cobertura y se llevaban la hoja por delante, antes del modelo.
 *  2. El renglón de TOTAL DUPLICABA la columna en `sheet-duplication`, así que ninguna hoja con
 *     TOTAL podía empatar con su consolidado ni con su detalle: el módulo entero se apoya en
 *     que dos hojas sumen lo mismo.
 *  3. `Presupuesto` —proyecciones por trimestre— se despivotaba en 12 movimientos y metía al
 *     dashboard dinero que nadie cobró ni pagó. Pasaba las cinco guardas del despivotado.
 *  4. Y el consolidado propio de cuatro filas, que ya se había cerrado ese mismo día.
 */
describe('EL INFIERNO: 17 hojas, 7 producen movimientos', () => {
  const libro = libroElInfierno();
  const c = correrPipeline(libro);

  test('el ingreso es EXACTO contra la verdad de campo', () => {
    // Ventas + su mostrador + la facturación en USD devengada UNA vez. Ni el resumen propio, ni
    // la copia exacta, ni la cartera de clientes, ni los cobros, ni el presupuesto.
    expect(c.totales.revenue).toBeCloseTo(libro.verdad.revenue, 2);
  });

  test('cada hoja termina donde debe, y se nombran las diecisiete', () => {
    const esperado: Record<string, string> = {
      Portada: 'movimientos:0',
      Ventas: 'movimientos:16',
      'Ventas (2)': 'descartada:duplica',
      Resumen_Ventas: 'descartada:reporte',
      Clientes_B2B: 'descartada:catalogo:contactos',
      Productos: 'descartada:catalogo:productos',
      Tiendas: 'descartada:catalogo:ubicaciones',
      Inventario: 'inventario',
      OrdenesCompra: 'movimientos:0',
      LineasOC: 'descartada:duplica',
      Gastos_Operativos: 'movimientos:24:despivotada',
      Estado_Resultados: 'descartada:reporte',
      Facturacion: 'movimientos:8',
      Cobros: 'movimientos:0',
      Presupuesto: 'descartada:reporte',
      Servicios_Varios: 'movimientos:0',
      Ventas_Mostrador: 'movimientos:9',
      Notas: 'movimientos:0',
    };
    for (const [hoja, destino] of Object.entries(esperado)) {
      expect(`${hoja}=${c.destino.get(hoja)}`).toBe(`${hoja}=${destino}`);
    }
  });

  test('lo que espera al cliente es lo que su dinero necesita', () => {
    /*
     * 30 filas de baja confianza —12 órdenes de compra con su costo derivado y 6 servicios de
     * concepto ambiguo— más 4 que ninguna categoría arregla: la fila en EUR y la de fecha
     * imposible, cada una con su costo en la línea.
     */
    expect(c.marcadas).toBe(libro.marcadas ?? 0);
    expect(c.motivos.get('invalid_currency') ?? 0).toBe(2);
    expect(c.motivos.get('invalid_date') ?? 0).toBe(2);
    expect(c.motivos.get('low_confidence:0.45') ?? 0).toBe(30);
  });

  test('el costo y el gasto retenidos son EXACTAMENTE lo que falta para cuadrar', () => {
    /*
     * Esta es la afirmación que vale del flujo nuevo: lo que el cliente contesta no es "algo
     * más", es la diferencia EXACTA entre lo que el dashboard muestra y su contabilidad real.
     * Si esto deja de cuadrar, contestar dejó de servir para algo.
     */
    const faltaCogs = libro.verdad.cogs - c.totales.cogs;
    const faltaOpex = libro.verdad.opex - c.totales.opex;
    expect(faltaCogs).toBeGreaterThan(0);
    expect(faltaOpex).toBeGreaterThan(0);
    // El costo retenido es el total de `OrdenesCompra`; el gasto, el de `Servicios_Varios`.
    expect(faltaCogs).toBeCloseTo(50_168.4, 2);
    expect(faltaOpex).toBeCloseTo(10_147.5, 2);
  });
});
