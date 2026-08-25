import { describe, expect, test } from 'bun:test';
import { detectarFilaDeEncabezado } from './sheet-header';

/**
 * Las filas de abajo son las REALES de los archivos de clientes, no casos de laboratorio.
 *
 * Lo que se protege: si esta detección se equivoca, NADA falla de forma visible — el
 * pre-filtro, el mapa de columnas y los índices que devuelve el modelo se desplazan todos a
 * la vez y los datos salen de las columnas equivocadas. Es el modo de fallo silencioso más
 * caro que puede tener la ingesta.
 */

// Kapel, hoja "Reporte mensual 2026": dos líneas de título y una fila de marcas de sección
// antes del encabezado real. El formato normal de un Excel hecho por una persona.
const KAPEL = [
  ['KAPEL ROASTING'],
  ['REPORTE DE VENTAS '],
  [46023, null, null, null, null, null, null, null, null, null, null, null, 'UNIDADES', null, null, 'EFECTIVO'],
  ['Fecha','Cliente','Calidad','Presentación','Cantidad','Peso de bolsa','P. Unidad','Sub total','Costo unitario del pedido','Costo del pedido'],
  [46031, 'Aldo Barrios', 'Kapel Blend', 'Grano', 1, 900, 0, 0, 16.76, 16.76],
  [46031, 'Aldo Barrios', 'House Blend', 'Grano', 1, 900, 0, 0, 16.76, 16.76],
  [46038, 'Christian Guzmán', 'Un Cafecito', 'Molido', 18, 400, 28, 504, 5.87, 105.69],
]; // prettier-ignore

// Kapel, hoja "Resumen": un solo título arriba.
const RESUMEN = [
  [null, 'RESUMEN ANNUAL 2026', null, null, null, null, null, null, null, null, null],
  ['Mes','Clientes','Cantidad','Peso en gr','Libras tostadas','Libras verde','Costo','Costo Total','Venta','Venta Total','Utilidad Bruta %'],
  ['Enero', 13, 90, 33300, 73.34, 86.55, 4.72, 425.27, 39.97, 3598, 0.88],
  ['Febrero', 14, 111, 38318, 84.4, 99.59, 2.59, 288.2, 33.35, 3702, 0.92],
]; // prettier-ignore

// Cafetería: encabezado en la primera fila, el caso sano.
const CAFETERIA = [
  ['Fecha','ID_Producto','Producto','Categoría','Unidades Vendidas','Precio Unitario (Q)','Ingreso Total (Q)','Costo Total (Q)'],
  [46174, 'P01', 'Café Americano', 'Bebidas Calientes', 6, 18, 108, 27],
  [46175, 'P02', 'Capuchino', 'Bebidas Calientes', 3, 25, 75, 20],
]; // prettier-ignore

describe('encontrar el encabezado real', () => {
  test('lo encuentra debajo de dos títulos y una fila de marcas', () => {
    /*
     * El caso que motivó todo. Leíamos `["KAPEL ROASTING"]` como los nombres de columna, y
     * esa hoja trae "Costo del pedido": el costo por fila estaba ahí y se perdía por dos
     * líneas de título.
     */
    expect(detectarFilaDeEncabezado(KAPEL)).toBe(3);
  });

  test('lo encuentra debajo de un título suelto', () => {
    expect(detectarFilaDeEncabezado(RESUMEN)).toBe(1);
  });

  test('no se mueve cuando ya está en la primera fila', () => {
    // El caso sano tiene que seguir siéndolo: mover el corte acá descartaría una venta real.
    expect(detectarFilaDeEncabezado(CAFETERIA)).toBe(0);
  });
});

describe('el sesgo va hacia NO moverse', () => {
  test('una hoja que es toda texto se queda en 0', () => {
    /*
     * Un catálogo de nombres: todas las filas son texto y única, así que por puntaje solo
     * cualquiera podría "ganar". Lo que lo evita es exigir que las filas de ABAJO se vean
     * menos encabezado — acá no se ven, así que no hay evidencia de dónde empieza la tabla.
     *
     * Equivocarse aquí descartaría una fila real del cliente Y desplazaría el mapa.
     */
    const catalogo = [
      ['Cliente', 'Ciudad', 'Vendedor'],
      ['Alejandra Sandoval', 'Guatemala', 'Marco'],
      ['Christian Guzmán', 'Antigua', 'Lucía'],
      ['CONCACAF', 'Guatemala', 'Marco'],
    ];
    expect(detectarFilaDeEncabezado(catalogo)).toBe(0);
  });

  test('una hoja de una sola fila no se toca', () => {
    expect(detectarFilaDeEncabezado([['Fecha', 'Monto']])).toBe(0);
    expect(detectarFilaDeEncabezado([])).toBe(0);
  });

  test('no busca más allá del principio de la hoja', () => {
    // Un encabezado en la fila 30 es otra clase de archivo, no una tabla con títulos. Buscar
    // indefinidamente aumentaría las chances de elegir mal sin resolver ningún caso real.
    const tarde = [
      ...Array.from({ length: 20 }, (_, i) => [i, i * 2, i * 3]),
      ['Fecha', 'Cliente', 'Monto'],
      [46031, 'Aldo', 100],
    ];
    expect(detectarFilaDeEncabezado(tarde)).toBe(0);
  });

  test('una fila de datos con texto no le gana al encabezado', () => {
    // "Aldo Barrios / Kapel Blend / Grano" son tres textos únicos: por proporción de texto se
    // parece a un encabezado. Lo que lo distingue es que sus vecinas de abajo se ven igual.
    const filas = [
      ['Fecha', 'Cliente', 'Producto', 'Presentación', 'Monto'],
      [46031, 'Aldo Barrios', 'Kapel Blend', 'Grano', 100],
      [46032, 'Christian Guzmán', 'House Blend', 'Molido', 250],
      [46033, 'CONCACAF', 'Office Blend', 'Grano', 120],
    ];
    expect(detectarFilaDeEncabezado(filas)).toBe(0);
  });
});

/**
 * ═══ LA REGRESIÓN QUE DESACTIVÓ LOS SEIS FILTROS (CarsGT, 2026-08-24) ═══
 *
 * Este es el caso que el puntaje solo no podía resolver, y no por poco margen conceptual sino
 * por 0,014 de aritmética. Una tabla con columnas descriptivas —cliente, vendedor, VIN, marca,
 * modelo— tiene filas de datos con `unicos` = 1,00 y `cobertura` = 1,00, iguales a las del
 * encabezado. El único discriminante que queda es `proporcionTexto`, que pesa 0,35, y el
 * margen exigido sobre las filas de abajo era 0,2: el encabezado necesitaba más de 1,00 sobre
 * un máximo de 1,00.
 *
 * Lo que costó no fue una columna mal leída. Al quedarse en la fila 0 —el título de la hoja—
 * `classifySheet` recibía un encabezado de UNA celda, lo declaraba ilegible y mandaba la hoja
 * al modelo; con eso se cayeron a la vez el pre-filtro de catálogos, la firma de `existencias`
 * y la forma de hoja. Las cinco hojas del libro fueron al modelo y el archivo costó USD 0,90
 * por mil filas, el más caro de la semana.
 */
describe('una tabla con columnas descriptivas encuentra su encabezado', () => {
  /** `Ventas` de `Concesionaria_Guatemala`: dos líneas de título y datos ricos en texto. */
  const hojaDeConcesionaria = (): unknown[][] => {
    const rows: unknown[][] = [
      ['Ventas'],
      ['Registro de ventas de vehiculos'],
      [
        'ID Venta',
        'Fecha',
        'Cliente',
        'Vendedor',
        'ID Vehiculo',
        'VIN',
        'Marca',
        'Modelo',
        'Tipo',
        'Sucursal',
        'Precio Venta (Q)',
        'Costo Vehiculo (Q)',
      ],
    ];
    for (let i = 0; i < 8; i++) {
      rows.push([
        `V-000${i}`,
        45_800 + i,
        `Cliente ${i}`,
        `Vendedor ${i}`,
        `VH-00${i}`,
        `3N1AB7AP${i}KY123456`,
        'Mazda',
        'CX-5',
        'Sedan',
        'Vista Hermosa',
        200_400 + i,
        162_552 + i,
      ]);
    }
    return rows;
  };

  test('elige la fila de encabezados y no el título', () => {
    expect(detectarFilaDeEncabezado(hojaDeConcesionaria())).toBe(2);
  });

  test('el sesgo se conserva: en una hoja de puro texto no se mueve', () => {
    /*
     * Es la contraparte y el motivo por el que la señal nueva mira TIPOS y no texto: si ninguna
     * columna cambia de tipo hacia abajo, no hay evidencia, y mover el corte descartaría una
     * fila real del cliente. Un catálogo de nombres se queda en 0.
     */
    const rows: unknown[][] = [['Nombre', 'Ciudad', 'Pais', 'Contacto']];
    for (let i = 0; i < 8; i++) {
      rows.push([`Empresa ${i}`, 'Guatemala', 'Guatemala', `Contacto ${i}`]);
    }
    expect(detectarFilaDeEncabezado(rows)).toBe(0);
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * EL TÍTULO ANGOSTO Y EL TÍTULO ANCHO — dos formas de quedarse en la fila 0 (2026-08-25)
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *
 * Salieron de correr el pipeline determinista completo contra un corpus de libros de cinco
 * rubros generados para eso. El primero apareció en la hoja de catálogo de clientes de una
 * joyería y es el que importa, porque su daño es en cascada y silencioso: si el detector se
 * queda en el título, `classifySheet` recibe una sola celda, la declara ilegible, y **se apagan
 * a la vez el pre-filtro de catálogos, la firma de existencias y la forma de hoja**. El
 * catálogo entero va al modelo y sus filas quedan a un veredicto de convertirse en movimientos
 * que el cliente nunca tuvo.
 *
 * Ninguna de las dos señales que existían podía verlo, y no por descuido: en una hoja de puro
 * texto el encabezado y los datos puntúan igual, y ninguna columna cambia de tipo.
 */
describe('una fila de título no es un encabezado', () => {
  test('el catálogo de clientes: título de una celda sobre una tabla de seis', () => {
    const rows: unknown[][] = [
      ['Catalogo de Clientes'],
      ['Base de clientes'],
      ['ID Cliente', 'Nombre', 'Apellido', 'Email', 'Telefono', 'Nivel Lealtad'],
    ];
    for (let i = 0; i < 8; i++) {
      rows.push([`C-${i}`, `Nombre${i}`, `Apellido${i}`, `c${i}@mail.com`, `5555-000${i}`, 'Oro']);
    }
    expect(detectarFilaDeEncabezado(rows)).toBe(2);
  });

  test('cuatro líneas de título seguidas', () => {
    const rows: unknown[][] = [
      ['FERRETERIA EL TORNILLO'],
      ['Reporte de ventas'],
      ['Periodo: enero a diciembre 2025'],
      ['Generado por: sistema'],
      ['Fecha', 'Producto', 'Cantidad', 'Total'],
      ['2025-01-05', 'Martillo', 2, 300],
      ['2025-01-06', 'Clavos', 10, 150],
      ['2025-01-07', 'Pintura', 3, 900],
    ];
    expect(detectarFilaDeEncabezado(rows)).toBe(4);
  });

  /*
   * La otra forma: el título llena TODA la fila, así que la guarda geométrica no aplica. Lo
   * resuelve que el encabezado rompa el tipo de sus columnas — `Cantidad` y `Total` son texto
   * arriba y números abajo. Es el formato que exportan varios sistemas contables
   * ("Empresa: | ACME | Periodo: | 2025").
   */
  test('el título ancho: mismas celdas que el encabezado, todo texto', () => {
    const rows: unknown[][] = [
      ['Reporte', 'de', 'Ventas', '2025', 'Confidencial'],
      ['Fecha', 'Producto', 'Cantidad', 'Total', 'Sucursal'],
      ['2025-01-05', 'Martillo', 2, 300, 'Centro'],
      ['2025-01-06', 'Clavos', 10, 150, 'Centro'],
      ['2025-01-07', 'Pintura', 3, 900, 'Norte'],
    ];
    expect(detectarFilaDeEncabezado(rows)).toBe(1);
  });

  test('los montos que vienen como TEXTO no apagan la detección', () => {
    // `rompeElTipoDeSusColumnas` da 0 acá (todo es texto); lo salva la guarda geométrica.
    const rows: unknown[][] = [
      ['Gastos del Periodo'],
      ['Fecha', 'Concepto', 'Monto'],
      ['05/01/2025', 'Nomina', 'Q 12,500.00'],
      ['06/01/2025', 'Renta', 'Q 8,000.00'],
      ['07/01/2025', 'Luz', 'Q 1,240.50'],
    ];
    expect(detectarFilaDeEncabezado(rows)).toBe(1);
  });

  describe('y el sesgo de no moverse se conserva', () => {
    test('una tabla de UNA columna no activa la guarda', () => {
      const rows: unknown[][] = [['Notas'], ['Primera'], ['Segunda'], ['Tercera'], ['Cuarta']];
      expect(detectarFilaDeEncabezado(rows)).toBe(0);
    });

    test('sin título, la fila 0 YA es el encabezado', () => {
      const rows: unknown[][] = [
        ['ID', 'Nombre', 'Apellido', 'Email'],
        ['C-1', 'Ana', 'Lopez', 'a@x.com'],
        ['C-2', 'Luis', 'Perez', 'l@x.com'],
        ['C-3', 'Eva', 'Diaz', 'e@x.com'],
      ];
      expect(detectarFilaDeEncabezado(rows)).toBe(0);
    });

    test('una hoja sin cuerpo no adivina: la guarda se desactiva sola', () => {
      expect(detectarFilaDeEncabezado([['Hoja en blanco'], [], []])).toBe(0);
    });

    /*
     * La PRIMERA fila de datos a medio llenar no puede bajar el ancho típico del cuerpo: por eso
     * se usa la mediana de varias filas y no la de al lado.
     */
    test('una fila de datos incompleta no mueve el ancho del cuerpo', () => {
      const rows: unknown[][] = [
        ['Inventario'],
        ['SKU', 'Producto', 'Cantidad', 'Costo', 'Ubicacion'],
        ['A-1', 'Tornillo'],
        ['A-2', 'Tuerca', 40, 3, 'Bodega'],
        ['A-3', 'Arandela', 90, 1, 'Bodega'],
        ['A-4', 'Clavo', 25, 2, 'Bodega'],
      ];
      expect(detectarFilaDeEncabezado(rows)).toBe(1);
    });
  });
});
