import { describe, expect, test } from 'bun:test';
import { detectarDetalleDuplicado } from './sheet-duplication';

/**
 * La garantía: las compras del cliente no se cuentan dos veces.
 *
 * Un archivo real (Joyería, 2026-08-14) trae las compras a dos granularidades:
 *   OrdenesCompra  60 filas · MontoTotal = 2.707.318,00
 *   LineasOC      220 filas · TotalLinea = 2.707.318,00
 * La orden OC-0001 vale 48.610 y sus tres líneas suman exactamente 48.610.
 *
 * Hoy no se duplican, pero POR ACCIDENTE: las líneas no traen proveedor —vive en la
 * cabecera— así que se marcan y no se promueven. El arreglo "obvio" era unir el proveedor
 * para que dejaran de marcarse, y habría duplicado Q 2,7 millones.
 */

const CABECERA = [
  ['IDOC', 'IDProveedor', 'FechaOrden', 'Estado', 'MontoTotal'],
  ['OC-0001', 'PRV-01', 45300, 'Recibida', 48610],
  ['OC-0002', 'PRV-02', 45310, 'Recibida', 21000],
  ['OC-0003', 'PRV-01', 45320, 'Pendiente', 30390],
]; // prettier-ignore

const DETALLE = [
  ['IDLineaOC', 'IDOC', 'SKU', 'CantidadPedida', 'CostoUnitario', 'TotalLinea'],
  ['L-1', 'OC-0001', 'SKU-A', 10, 2000, 20000],
  ['L-2', 'OC-0001', 'SKU-B', 5, 3000, 15000],
  ['L-3', 'OC-0001', 'SKU-C', 3, 4536.67, 13610],
  ['L-4', 'OC-0002', 'SKU-A', 7, 3000, 21000],
  ['L-5', 'OC-0003', 'SKU-D', 6, 5065, 30390],
]; // prettier-ignore

describe('cabecera y detalle: el mismo dinero dos veces', () => {
  test('se descarta el DETALLE, no la cabecera', () => {
    const r = detectarDetalleDuplicado([
      { nombre: 'OrdenesCompra', rows: CABECERA },
      { nombre: 'LineasOC', rows: DETALLE },
    ]);
    expect([...r.keys()]).toEqual(['LineasOC']);
  });

  test('el motivo explica que fue para no duplicar', () => {
    // Lo lee el dueño de una PYME en `documents.error_reason`. "Hoja omitida" lo dejaría
    // creyendo que perdimos sus compras; hay que decirle que están, contadas una sola vez.
    const r = detectarDetalleDuplicado([
      { nombre: 'OrdenesCompra', rows: CABECERA },
      { nombre: 'LineasOC', rows: DETALLE },
    ]);
    expect(r.get('LineasOC')).toContain('OrdenesCompra');
    expect(r.get('LineasOC')).toContain('duplicar');
  });

  test('el orden en que llegan las hojas no cambia el resultado', () => {
    const alReves = detectarDetalleDuplicado([
      { nombre: 'LineasOC', rows: DETALLE },
      { nombre: 'OrdenesCompra', rows: CABECERA },
    ]);
    expect([...alReves.keys()]).toEqual(['LineasOC']);
  });
});

describe('lo que NO debe descartarse', () => {
  test('sin encabezado compartido no hay relación, aunque sumen igual', () => {
    /*
     * La condición que evita el falso positivo caro. Dos hojas sin nada en común pueden sumar
     * parecido por casualidad —dos meses de venta de tamaño similar— y descartar una perdería
     * contabilidad real, en silencio.
     */
    const otra = [
      ['Fecha', 'Cliente', 'Monto'],
      [45300, 'Aldo', 50000],
      [45310, 'Ana', 49610],
    ];
    expect(
      detectarDetalleDuplicado([
        { nombre: 'A', rows: CABECERA },
        { nombre: 'B', rows: otra },
      ]).size,
    ).toBe(0);
  });

  test('las columnas de FECHA no se confunden con dinero', () => {
    /*
     * El error que tuvo la primera versión: un serial de Excel vale ~45.000, así que sesenta
     * fechas suman MÁS que la columna de dinero de esa misma hoja. Tomando "la suma más
     * grande" se comparaba la fecha de entrega contra el total de las compras y la detección
     * fallaba por 2 %.
     */
    const soloFechas = [
      ['IDOC', 'FechaOrden'],
      ['OC-0001', 45300],
      ['OC-0002', 45310],
      ['OC-0003', 45320],
    ];
    const sumaFechas = 45300 + 45310 + 45320;
    const conDinero = [
      ['IDOC', 'Monto'],
      ['OC-0001', sumaFechas / 3],
      ['OC-0002', sumaFechas / 3],
      ['OC-0003', sumaFechas / 3],
    ];
    // Suman exactamente lo mismo y comparten "IDOC", pero una columna es de fechas.
    expect(
      detectarDetalleDuplicado([
        { nombre: 'Fechas', rows: soloFechas },
        { nombre: 'Dinero', rows: conDinero },
      ]).size,
    ).toBe(0);
  });

  test('dos hojas con el mismo número de filas no se tocan', () => {
    // Sin una cabecera clara —una con menos filas que la otra— no se puede decir cuál es el
    // detalle, y elegir al azar podría descartar la buena.
    const a = [...CABECERA];
    const b = [['IDOC', 'Otro', 'MontoTotal'], ['OC-0001', 'x', 48610], ['OC-0002', 'y', 21000], ['OC-0003', 'z', 30390]]; // prettier-ignore
    expect(
      detectarDetalleDuplicado([
        { nombre: 'A', rows: a },
        { nombre: 'B', rows: b },
      ]).size,
    ).toBe(0);
  });

  test('hojas que no se parecen en montos se dejan en paz', () => {
    const ventas = [
      ['Fecha', 'Producto', 'Monto'],
      [45300, 'Café', 100],
      [45310, 'Té', 200],
    ];
    expect(
      detectarDetalleDuplicado([
        { nombre: 'OrdenesCompra', rows: CABECERA },
        { nombre: 'Ventas', rows: ventas },
      ]).size,
    ).toBe(0);
  });
});
