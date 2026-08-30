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
    // El mensaje dice "el mismo dinero" y no "tus compras": el módulo también descarta
    // resúmenes de VENTAS, y ahí nombrar compras era falso. Ver el motivo en el módulo.
    expect(r.get('LineasOC')).toContain('el mismo dinero dos veces');
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

  test('mismo número de filas y las dos se bastan solas: no se tocan', () => {
    /*
     * Cuando las dos hojas traen contraparte y fecha, la autosuficiencia no las distingue y
     * lo único que queda es el tamaño. Con el mismo número de filas no hay cabecera clara, y
     * elegir al azar podría descartar la buena.
     */
    const a = [...CABECERA];
    const b = [['IDOC', 'IDProveedor', 'FechaOrden', 'Otro', 'MontoTotal'], ['OC-0001', 'PRV-01', 45300, 'x', 48610], ['OC-0002', 'PRV-02', 45310, 'y', 21000], ['OC-0003', 'PRV-01', 45320, 'z', 30390]]; // prettier-ignore
    expect(
      detectarDetalleDuplicado([
        { nombre: 'A', rows: a },
        { nombre: 'B', rows: b },
      ]).size,
    ).toBe(0);
  });

  /*
   * ═════════════════════════════════════════════════════════════════════════════════════════
   * REGRESIÓN KapePrueba (2026-08-28): UN RESUMEN NO ES UNA CABECERA
   * ═════════════════════════════════════════════════════════════════════════════════════════
   *
   * El libro de demo traía `Ventas` (481 filas, con Fecha y Cliente) y su propio consolidado
   * `Resumen_Mensual` (11 filas, un total por mes). Con "menos filas = cabecera" se
   * descartaron las 481 ventas para conservar el resumen — y el resumen lo descartaba después
   * otro filtro, así que el dashboard del cliente quedó sin una sola venta.
   *
   * Se usan pocas filas a propósito: el defecto NO era de escala, era del criterio.
   */
  const VENTAS = [
    ['Fecha', 'Mes', 'Documento', 'Cliente', 'Venta neta'],
    [46024, 46023, 'VD-001', 'Mostrador', 100],
    [46055, 46054, 'VD-002', 'Café Central', 200],
    [46083, 46054, 'VD-003', 'Mostrador', 300],
    [46114, 46054, 'VD-004', 'La Bodeguita', 400],
  ]; // prettier-ignore

  const RESUMEN = [
    ['Mes', 'Venta neta total'],
    [46023, 300],
    [46054, 700],
  ]; // prettier-ignore

  test('se conserva el DETALLE con contraparte, no el resumen mensual', () => {
    const r = detectarDetalleDuplicado([
      { nombre: 'Ventas', rows: VENTAS },
      { nombre: 'Resumen_Mensual', rows: RESUMEN },
    ]);
    expect(r.has('Ventas')).toBe(false);
    expect(r.has('Resumen_Mensual')).toBe(true);
  });

  test('el orden en que llegan las hojas no cambia el veredicto', () => {
    const r = detectarDetalleDuplicado([
      { nombre: 'Resumen_Mensual', rows: RESUMEN },
      { nombre: 'Ventas', rows: VENTAS },
    ]);
    expect(r.has('Ventas')).toBe(false);
    expect(r.has('Resumen_Mensual')).toBe(true);
  });

  test('si la conservada no va a producir movimientos, no se descarta NADA', () => {
    /*
     * La otra mitad del fallo de KapePrueba: el dedup conservaba una hoja que el filtro
     * siguiente descartaba por su cuenta. Las dos decisiones eran defendibles por separado y
     * juntas dejaban el dashboard en cero. Acá se invierte la autosuficiencia para forzar que
     * la ganadora sea la marcada como no procesable.
     */
    const r = detectarDetalleDuplicado([
      { nombre: 'OrdenesCompra', rows: CABECERA, puedeProducirMovimientos: false },
      { nombre: 'LineasOC', rows: DETALLE, puedeProducirMovimientos: true },
    ]);
    expect(r.size).toBe(0);
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

/*
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * REGRESIÓN: LA FECHA EN TEXTO TAMBIÉN CUENTA (2026-08-30)
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *
 * `tieneColumnaDeFecha` miraba solo objetos `Date` y seriales numéricos. Una hoja con fechas
 * ISO en texto —como las trae cualquier archivo que pasó por un CSV— no contaba como
 * autosuficiente, así que empataba en "ninguna se basta sola" contra un agregado y el
 * desempate caía de vuelta al PROXY del tamaño: el criterio que este módulo dejó de usar
 * justamente porque vaciaba libros enteros.
 *
 * Medido: un libro con `Ventas` (48 filas, Cliente + fecha ISO) y una matriz de ingresos por
 * categoría despivotada (24 filas, sin contraparte) descartaba las 48 ventas de detalle para
 * conservar el agregado sintético.
 */
describe('la autosuficiencia se mide con el mismo lector de fechas del pipeline', () => {
  const VENTAS_ISO = [
    ['Fecha', 'Cliente', 'Producto', 'Monto'],
    ['2026-01-12', 'Cafetería El Roble', 'Café en grano 1 kg', 500],
    ['2026-02-08', 'Súper Zona 10', 'Café molido 250 g', 300],
    ['2026-03-19', 'Bistró La Cuadra', 'Cápsulas x10', 400],
    ['2026-04-02', 'Cafetería El Roble', 'Café en grano 1 kg', 600],
  ]; // prettier-ignore

  /** Lo que sale de despivotar una matriz: fecha, concepto y monto. Sin contraparte. */
  const AGREGADO = [
    ['Fecha', 'Concepto', 'Monto'],
    ['2026-01-01', 'Café en grano', 900],
    ['2026-02-01', 'Café molido', 500],
    ['2026-03-01', 'Cápsulas', 400],
  ]; // prettier-ignore

  test('gana la hoja con contraparte, aunque tenga MÁS filas', () => {
    const r = detectarDetalleDuplicado([
      { nombre: 'Ventas', rows: VENTAS_ISO },
      { nombre: 'Ventas por categoria', rows: AGREGADO },
    ]);
    expect(r.has('Ventas')).toBe(false);
    expect(r.has('Ventas por categoria')).toBe(true);
  });

  test('el orden en que llegan no cambia el veredicto', () => {
    const r = detectarDetalleDuplicado([
      { nombre: 'Ventas por categoria', rows: AGREGADO },
      { nombre: 'Ventas', rows: VENTAS_ISO },
    ]);
    expect(r.has('Ventas')).toBe(false);
    expect(r.has('Ventas por categoria')).toBe(true);
  });
});
