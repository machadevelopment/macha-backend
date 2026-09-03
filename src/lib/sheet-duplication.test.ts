import { describe, expect, test } from 'bun:test';
import { detectarDetalleDuplicado, detectarHechosRepetidos } from './sheet-duplication';

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

/*
 * Los fixtures tienen NUEVE órdenes y no tres, y no es cosmético: el detector exige un piso de
 * filas antes de afirmar que dos hojas son el mismo dinero (`MIN_FILAS_PARA_AFIRMAR`). Con tres
 * filas, dos totales iguales se explican por azar tan bien como por duplicación — y ese falso
 * positivo ya descartó los gastos de un libro real. El caso que este módulo existe para atrapar
 * es grande por naturaleza (60 órdenes y 220 líneas en el archivo que lo motivó), así que el
 * piso no le quita nada.
 */
const CABECERA = [
  ['IDOC', 'IDProveedor', 'FechaOrden', 'Estado', 'MontoTotal'],
  ['OC-0001', 'PRV-01', 45300, 'Recibida', 48610],
  ['OC-0002', 'PRV-02', 45310, 'Recibida', 21000],
  ['OC-0003', 'PRV-01', 45320, 'Pendiente', 30390],
  ['OC-0004', 'PRV-03', 45330, 'Recibida', 17250],
  ['OC-0005', 'PRV-02', 45340, 'Recibida', 26400],
  ['OC-0006', 'PRV-01', 45350, 'Pendiente', 12800],
  ['OC-0007', 'PRV-04', 45360, 'Recibida', 33150],
  ['OC-0008', 'PRV-03', 45370, 'Recibida', 19600],
  ['OC-0009', 'PRV-02', 45380, 'Pendiente', 24900],
]; // prettier-ignore

const DETALLE = [
  ['IDLineaOC', 'IDOC', 'SKU', 'CantidadPedida', 'CostoUnitario', 'TotalLinea'],
  ['L-1', 'OC-0001', 'SKU-A', 10, 2000, 20000],
  ['L-2', 'OC-0001', 'SKU-B', 5, 3000, 15000],
  ['L-3', 'OC-0001', 'SKU-C', 3, 4536.67, 13610],
  ['L-4', 'OC-0002', 'SKU-A', 7, 3000, 21000],
  ['L-5', 'OC-0003', 'SKU-D', 6, 5065, 30390],
  ['L-6', 'OC-0004', 'SKU-B', 5, 3450, 17250],
  ['L-7', 'OC-0005', 'SKU-A', 8, 3300, 26400],
  ['L-8', 'OC-0006', 'SKU-C', 4, 3200, 12800],
  ['L-9', 'OC-0007', 'SKU-D', 6, 5525, 33150],
  ['L-10', 'OC-0008', 'SKU-B', 7, 2800, 19600],
  ['L-11', 'OC-0009', 'SKU-A', 9, 2766.67, 24900],
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

  test('mismo número de filas y totales PARECIDOS pero no idénticos: no se tocan', () => {
    /*
     * Cuando las dos hojas traen contraparte y fecha, la autosuficiencia no las distingue y lo
     * único que queda es el tamaño. Con el mismo número de filas no hay cabecera clara, y
     * elegir al azar podría descartar la buena.
     *
     * El total de `b` cae dentro del 1 % de `a` —suficiente para que el detector las relacione—
     * pero NO es el mismo al centavo: son dos conjuntos de datos distintos que se parecen, que
     * es exactamente el caso que esta regla protege.
     */
    const a = [...CABECERA];
    const b = [['IDOC', 'IDProveedor', 'FechaOrden', 'Otro', 'MontoTotal'], ['OC-0001', 'PRV-01', 45300, 'x', 48610], ['OC-0002', 'PRV-02', 45310, 'y', 21000], ['OC-0003', 'PRV-01', 45320, 'z', 30100]]; // prettier-ignore
    expect(
      detectarDetalleDuplicado([
        { nombre: 'A', rows: a },
        { nombre: 'B', rows: b },
      ]).size,
    ).toBe(0);
  });

  test('mismo número de filas y el MISMO dinero al centavo: es una copia', () => {
    /*
     * ═══ EL CASO QUE LA REGLA DE ARRIBA DEJABA PASAR (2026-08-30) ═══
     *
     * Dos hojas con el mismo número de filas y un total idéntico **al centavo**, que además
     * comparten encabezados, no son dos conjuntos parecidos: son la misma tabla dos veces —una
     * copia de respaldo, una hoja duplicada al exportar, `Ventas` y `Ventas (2)`—. Ninguna gana
     * por autosuficiencia (las dos la tienen) ni por tamaño (son iguales), así que caían en el
     * `continue` y **las dos se procesaban: la facturación del cliente salía al DOBLE**.
     *
     * El umbral acá es al centavo y no el 1 % del resto del módulo, y esa diferencia es la
     * regla: dos conjuntos distintos no suman exactamente lo mismo hasta el último decimal.
     */
    const a = [...CABECERA];
    // Las mismas filas con las columnas reordenadas: es como sale una hoja "copiar y pegar".
    const copia: unknown[][] = [
      ['MontoTotal', 'IDOC', 'IDProveedor', 'FechaOrden', 'Estado'],
      ...CABECERA.slice(1).map((f) => [f[4], f[0], f[1], f[2], f[3]]),
    ];
    const r = detectarDetalleDuplicado([
      { nombre: 'OrdenesCompra', rows: a },
      { nombre: 'OrdenesCompra (respaldo)', rows: copia },
    ]);
    expect(r.size).toBe(1);
    // Da igual cuál se descarte —son la misma tabla—: se conserva la primera del libro.
    expect(r.has('OrdenesCompra (respaldo)')).toBe(true);
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
    [46026, 46023, 'VD-002', 'Café Central', 150],
    [46030, 46023, 'VD-003', 'La Bodeguita', 250],
    [46055, 46054, 'VD-004', 'Mostrador', 200],
    [46058, 46054, 'VD-005', 'Café Central', 180],
    [46083, 46054, 'VD-006', 'Mostrador', 300],
    [46090, 46054, 'VD-007', 'La Bodeguita', 220],
    [46114, 46085, 'VD-008', 'La Bodeguita', 400],
    [46118, 46085, 'VD-009', 'Café Central', 260],
    [46120, 46085, 'VD-010', 'Mostrador', 190],
  ]; // prettier-ignore

  const RESUMEN = [
    ['Mes', 'Documento', 'Venta neta total'],
    [46023, 'RES-01', 500],
    [46054, 'RES-02', 900],
    [46085, 'RES-03', 850],
    [46116, 'RES-04', 0],
    [46147, 'RES-05', 0],
    [46177, 'RES-06', 0],
    [46208, 'RES-07', 0],
    [46238, 'RES-08', 0],
    [46269, 'RES-09', 0],
    [46300, 'RES-10', 0],
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
    ['2026-01-12', 'Cafetería El Roble', 'Café en grano', 500],
    ['2026-01-20', 'Súper Zona 10', 'Café en grano', 400],
    ['2026-02-08', 'Súper Zona 10', 'Café molido', 300],
    ['2026-02-14', 'Bistró La Cuadra', 'Café molido', 200],
    ['2026-03-19', 'Bistró La Cuadra', 'Cápsulas', 400],
    ['2026-03-25', 'Cafetería El Roble', 'Cápsulas', 350],
    ['2026-04-02', 'Cafetería El Roble', 'Café en grano', 600],
    ['2026-04-18', 'Súper Zona 10', 'Café molido', 250],
    ['2026-05-07', 'Bistró La Cuadra', 'Cápsulas', 300],
    ['2026-05-21', 'Cafetería El Roble', 'Café en grano', 450],
  ]; // prettier-ignore

  /** Lo que sale de despivotar una matriz: fecha, concepto y monto. Sin contraparte. */
  const AGREGADO = [
    ['Fecha', 'Concepto', 'Producto', 'Monto'],
    ['2026-01-01', 'Café en grano', 'Café en grano', 900],
    ['2026-02-01', 'Café molido', 'Café molido', 500],
    ['2026-03-01', 'Cápsulas', 'Cápsulas', 750],
    ['2026-04-01', 'Café en grano', 'Café en grano', 600],
    ['2026-04-02', 'Café molido', 'Café molido', 250],
    ['2026-05-01', 'Cápsulas', 'Cápsulas', 300],
    ['2026-05-02', 'Café en grano', 'Café en grano', 450],
    ['2026-06-01', 'Café molido', 'Café molido', 0],
    ['2026-06-02', 'Cápsulas', 'Cápsulas', 0],
    ['2026-07-01', 'Café en grano', 'Café en grano', 0],
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

/*
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * DOS HOJAS CHICAS QUE SUMAN IGUAL SON CASUALIDAD, NO DUPLICACIÓN (2026-08-30)
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *
 * Este detector afirma algo fuerte —"estas dos hojas son el mismo dinero"— y equivocarse
 * cuesta la contabilidad de una hoja entera. Esa afirmación necesita masa y necesita una llave.
 *
 * Medido: un libro con `Ventas` (una venta de Q 1.500), `Compras` (Q 700) y `Gastos` (un
 * alquiler de Q 1.500) descartaba los GASTOS como duplicado de las VENTAS. Una venta y un
 * alquiler no son la misma plata: comparten la forma (`Fecha · Monto · Moneda`, que tiene
 * cualquier hoja de movimientos) y el total, por azar.
 */
describe('hace falta masa y una llave específica para afirmar duplicación', () => {
  const UNA_VENTA = [
    ['Fecha', 'Cliente', 'Monto', 'Moneda'],
    ['2026-08-15', 'Cafetería El Roble', 1500, 'GTQ'],
  ]; // prettier-ignore
  const UN_ALQUILER = [
    ['Fecha', 'Concepto', 'Monto', 'Moneda'],
    ['2026-08-05', 'Alquiler', 1500, 'GTQ'],
  ]; // prettier-ignore

  test('con una fila cada una NO se descarta nada, aunque sumen lo mismo', () => {
    expect(
      detectarDetalleDuplicado([
        { nombre: 'Ventas', rows: UNA_VENTA },
        { nombre: 'Gastos', rows: UN_ALQUILER },
      ]).size,
    ).toBe(0);
  });

  test('el piso de filas protege AUNQUE compartan una llave específica', () => {
    /*
     * Las dos defensas son independientes y hace falta comprobarlas por separado, o una tapa
     * el agujero de la otra en el test y nadie se entera de que una se rompió.
     *
     * Acá comparten `Documento` —una llave específica, no genérica— así que el filtro de
     * encabezados NO las salva. Lo único que queda entre estas cuatro filas y un descarte
     * equivocado es el piso: tres movimientos que suman lo mismo que otros tres siguen siendo
     * una coincidencia, no una cabecera con su detalle.
     */
    const ventas = [
      ['Fecha', 'Documento', 'Cliente', 'Monto'],
      ['2026-08-01', 'DOC-1', 'Cafetería El Roble', 1000],
      ['2026-08-02', 'DOC-2', 'Súper Zona 10', 2000],
      ['2026-08-03', 'DOC-3', 'Bistró La Cuadra', 3000],
    ]; // prettier-ignore
    const gastos = [
      ['Fecha', 'Documento', 'Concepto', 'Monto'],
      ['2026-08-05', 'DOC-9', 'Alquiler', 1500],
      ['2026-08-06', 'DOC-8', 'Sueldos', 2500],
      ['2026-08-07', 'DOC-7', 'Publicidad', 2000],
    ]; // prettier-ignore
    expect(detectarDetalleDuplicado([
      { nombre: 'Ventas', rows: ventas },
      { nombre: 'Gastos', rows: gastos },
    ]).size).toBe(0); // prettier-ignore
  });

  test('compartir SOLO encabezados genéricos no es evidencia de relación', () => {
    /*
     * `fecha`, `monto` y `moneda` los tiene cualquier hoja de movimientos, así que
     * compartirlos no dice nada: la condición se cumpliría entre dos hojas cualesquiera del
     * libro y lo único que quedaría decidiendo es la suma.
     */
    const ventas: unknown[][] = [['Fecha', 'Cliente', 'Monto', 'Moneda']];
    const gastos: unknown[][] = [['Fecha', 'Concepto', 'Monto', 'Moneda']];
    for (let i = 1; i <= 10; i++) {
      ventas.push([`2026-0${((i - 1) % 8) + 1}-15`, 'Cafetería El Roble', 100 * i, 'GTQ']);
      gastos.push([`2026-0${((i - 1) % 8) + 1}-05`, 'Alquiler', 100 * i, 'GTQ']);
    }
    // Suman exactamente lo mismo y tienen masa de sobra: lo único que falta es la llave.
    expect(detectarDetalleDuplicado([
      { nombre: 'Ventas', rows: ventas },
      { nombre: 'Gastos', rows: gastos },
    ]).size).toBe(0); // prettier-ignore
  });

  test('con una llave ESPECÍFICA compartida sí se detecta', () => {
    // El contraste: lo único que cambia es que ahora comparten `IDOC`, que es la llave por la
    // que una cabecera y su detalle de verdad se relacionan.
    expect(detectarDetalleDuplicado([
      { nombre: 'OrdenesCompra', rows: CABECERA },
      { nombre: 'LineasOC', rows: DETALLE },
    ]).size).toBe(1); // prettier-ignore
  });
});

describe('un consolidado por período chico también se descarta', () => {
  /*
   * Medido en producción el 2026-09-01: un libro con `Ventas` (4 movimientos, GTQ 945) y su
   * propio `Resumen_Mensual` (4 filas, GTQ 945) dejó el dashboard con **+945,00 sobre una
   * verdad de campo de 34.209,00** — el costo y los gastos exactos. Ni el dedup lo veía
   * (exigía 8 filas) ni la señal de resumen por período de `sheet-shape` (exige 6 meses).
   *
   * Se cierra combinando DOS señales débiles, no aflojando un umbral: empate AL CENTAVO más
   * forma de consolidado por período. Cada una sola tiene contraejemplo; ver abajo.
   */
  const ventas = [
    ['Fecha', 'Cliente', 'Producto', 'Cantidad', 'Monto'],
    [46023, 'Cliente 0', 'Producto 0', 1, 180],
    [46057, 'Cliente 1', 'Producto 1', 2, 217.5],
    [46088, 'Cliente 2', 'Producto 2', 3, 255],
    [46122, 'Cliente 3', 'Producto 3', 4, 292.5],
  ]; // prettier-ignore
  const resumen = [
    ['Mes', 'Total Ventas'],
    [46023, 180], [46054, 217.5], [46082, 255], [46113, 292.5],
  ]; // prettier-ignore

  const correr = (hojas: { nombre: string; rows: unknown[][] }[]) =>
    detectarDetalleDuplicado(hojas.map((h) => ({ ...h, puedeProducirMovimientos: true })));

  test('se descarta el RESUMEN y se conserva el detalle', () => {
    const r = correr([
      { nombre: 'Ventas', rows: ventas },
      { nombre: 'Resumen_Mensual', rows: resumen },
    ]);
    // Al revés se perdería el detalle por cliente y producto, que es lo que el cliente mira.
    expect([...r.keys()]).toEqual(['Resumen_Mensual']);
  });

  test('⚠️ sin compartir NINGÚN encabezado, que es lo que lo hace un resumen', () => {
    /*
     * `Mes · Total Ventas` contra `Fecha · Cliente · Producto · Cantidad · Monto`: cero
     * columnas en común. La llave compartida que el resto del módulo exige apagaría la regla
     * en el único caso para el que se escribió.
     */
    const encabezadoResumen = resumen[0]! as unknown[];
    const comunes = (ventas[0]! as unknown[]).filter((c) => encabezadoResumen.includes(c));
    expect(comunes).toHaveLength(0);
  });

  test('el contraejemplo sigue protegido: empatar al centavo NO alcanza', () => {
    /*
     * `Ventas` (1000+2000+3000) y `Gastos` (1500+2500+2000) suman 6000 las dos, con tres filas
     * y la llave `Documento` compartida. Dos hojas distintas que empatan exacto por azar. Lo
     * que las salva es que ninguna tiene forma de consolidado: sus días son 1·2·3 y 5·6·7 del
     * mismo mes, y traen columna de texto.
     */
    const v = [
      ['Fecha', 'Documento', 'Cliente', 'Monto'],
      ['2026-08-01', 'DOC-1', 'Cafetería El Roble', 1000],
      ['2026-08-02', 'DOC-2', 'Súper Zona 10', 2000],
      ['2026-08-03', 'DOC-3', 'Bistró La Cuadra', 3000],
    ]; // prettier-ignore
    const g = [
      ['Fecha', 'Documento', 'Concepto', 'Monto'],
      ['2026-08-05', 'DOC-9', 'Alquiler', 1500],
      ['2026-08-06', 'DOC-8', 'Sueldos', 2500],
      ['2026-08-07', 'DOC-7', 'Publicidad', 2000],
    ]; // prettier-ignore
    expect(correr([{ nombre: 'Ventas', rows: v }, { nombre: 'Gastos', rows: g }]).size).toBe(0); // prettier-ignore
  });

  test('y la forma de consolidado tampoco alcanza sola: sin empate no se toca', () => {
    // Un resumen que NO suma lo mismo que la otra hoja es contabilidad propia, no un duplicado.
    const otro = resumen.map((f, i) => (i === 0 ? f : [f[0], (f[1] as number) * 3]));
    expect(correr([
      { nombre: 'Ventas', rows: ventas },
      { nombre: 'Resumen_Mensual', rows: otro },
    ]).size).toBe(0); // prettier-ignore
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA CARTERA QUE REPITE LAS VENTAS, FILA POR FILA (2026-09-03)
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *
 * Encontrado probando de punta a punta en producción con un archivo real de cliente. Su
 * `Accounts Receivable` son las MISMAS ventas de `Sales Orders`, facturadas:
 *
 *     SO-2001  CU-005   440   |   INV-6001  CU-005   440
 *
 * Medido: 154 de 154 pares (cliente, monto) coinciden, y el dashboard mostró **268.195 sobre
 * 140.045 reales, +91 %** — cada venta contada dos veces, una como venta y otra como factura
 * devengando su ingreso.
 *
 * No lo atrapaba nada: el esquema del libro necesita una columna de referencia y esa plantilla
 * lleva `Invoice #` y `Cust. ID`, nunca `Order #`; y el dedup por TOTALES no empata (140.045
 * contra 128.150, porque no todo se facturó).
 *
 * ⚠️ Y lo que devuelve NO es "descartá la hoja". Es la misma bandera de la hoja de cobros: la
 * factura se crea igual —el cliente necesita su cartera— y lo único que no ocurre es el
 * devengo por segunda vez. Descartarla dejaría Por cobrar en cero, que es el bug de U3TECH.
 */
describe('detectarHechosRepetidos', () => {
  const CLIENTES = ['CU-005', 'CU-002', 'CU-004', 'CU-006', 'CU-010'];
  const MONTOS = [440, 130, 950, 585, 1850, 275, 690, 1120, 340, 2100, 505, 780];

  /** `Sales Orders`: 12 ventas. */
  const ventas = (): unknown[][] => [
    ['Order #', 'Order Date', 'Cust. ID', 'Customer Name', 'Total'],
    ...MONTOS.map((m, i) => [`SO-${2001 + i}`, 46027 + i, CLIENTES[i % 5], `Cliente ${i % 5}`, m]),
  ];

  /** `Accounts Receivable`: las MISMAS ventas facturadas, menos las tres últimas sin facturar. */
  const cartera = (): unknown[][] => [
    ['Invoice #', 'Cust. ID', 'Invoice Date', 'Due Date', 'Invoice Amount'],
    ...MONTOS.slice(0, 9).map((m, i) => [
      `INV-${6001 + i}`,
      CLIENTES[i % 5],
      46027 + i,
      46057 + i,
      m,
    ]),
  ];

  test('la cartera se marca como repetición de las ventas', () => {
    const r = detectarHechosRepetidos([
      { nombre: 'Sales Orders', rows: ventas() },
      { nombre: 'Accounts Receivable', rows: cartera() },
    ]);
    expect(r.get('Accounts Receivable')).toBe('Sales Orders');
    // ⚠️ Y NUNCA al revés: suprimir las ventas dejaría el dashboard sin su ingreso real.
    expect(r.has('Sales Orders')).toBe(false);
  });

  test('⚠️ los TOTALES no empatan, y por eso el dedup viejo no podía verlo', () => {
    // Es la razón por la que hace falta esta segunda vía y no bastaba bajar un umbral.
    const tv = MONTOS.reduce((s, m) => s + m, 0);
    const tc = MONTOS.slice(0, 9).reduce((s, m) => s + m, 0);
    expect(tc / tv).toBeLessThan(0.95);
  });

  test('dos hojas de movimientos DISTINTOS no se tocan', () => {
    /*
     * El modo de fallo caro: un falso positivo no muestra una cifra de más —que se ve— sino
     * que BORRA el ingreso de un cliente. Estas dos comparten forma y clientes, y sus montos
     * son otros.
     */
    const otras: unknown[][] = [
      ['Order #', 'Order Date', 'Cust. ID', 'Customer Name', 'Total'],
      ...MONTOS.map((m, i) => [`SO-${9001 + i}`, 46200 + i, CLIENTES[i % 5], `C${i}`, m + 7]),
    ];
    const r = detectarHechosRepetidos([
      { nombre: 'Ventas Q1', rows: ventas() },
      { nombre: 'Ventas Q2', rows: otras },
    ]);
    expect(r.size).toBe(0);
  });

  test('⚠️ la MULTIPLICIDAD cuenta: tres filas iguales no las cubre una sola', () => {
    /*
     * Si la cartera trae tres facturas de (CU-001, 440) y las ventas una sola, dos de esas
     * tres son dinero que nadie registró. Preguntar "¿existe?" en vez de consumir una
     * coincidencia por fila las daría por cubiertas y se perderían.
     */
    const repetidas: unknown[][] = [
      ['Invoice #', 'Cust. ID', 'Invoice Date', 'Invoice Amount'],
      ...Array.from({ length: 12 }, (_, i) => [`INV-${i}`, 'CU-005', 46027 + i, 440]),
    ];
    const r = detectarHechosRepetidos([
      { nombre: 'Sales Orders', rows: ventas() },
      { nombre: 'Cartera', rows: repetidas },
    ]);
    expect(r.has('Cartera')).toBe(false);
  });

  test('sin columna de CONTRAPARTE la regla no aplica', () => {
    /*
     * Sin ella la comparación sería solo por monto, y dos hojas de gastos de la misma PYME
     * comparten importes redondos todo el tiempo.
     */
    const sinQuien = cartera().map((f, i) => (i === 0 ? ['Invoice #', 'X', 'Invoice Date', 'Due Date', 'Invoice Amount'] : f)); // prettier-ignore
    const r = detectarHechosRepetidos([
      { nombre: 'Sales Orders', rows: ventas() },
      { nombre: 'Cartera', rows: sinQuien },
    ]);
    expect(r.size).toBe(0);
  });

  test('con POCAS filas no se afirma nada', () => {
    // Con tres, coincidir se explica por azar tan bien como por duplicación.
    const corta = (rows: unknown[][]) => [rows[0]!, ...rows.slice(1, 4)];
    const r = detectarHechosRepetidos([
      { nombre: 'Sales Orders', rows: corta(ventas()) },
      { nombre: 'Cartera', rows: corta(cartera()) },
    ]);
    expect(r.size).toBe(0);
  });

  test('⚠️ dos hojas IDÉNTICAS no las decide esta regla', () => {
    /*
     * Si cada una contiene a la otra son la misma tabla dos veces, y cuál conservar lo sabe
     * `detectarDetalleDuplicado`, que distingue una cabecera de un resumen. Elegir acá al azar
     * podría quedarse con la copia y tirar el original.
     */
    const r = detectarHechosRepetidos([
      { nombre: 'Ventas', rows: ventas() },
      { nombre: 'Ventas (2)', rows: ventas() },
    ]);
    expect(r.size).toBe(0);
  });
});
