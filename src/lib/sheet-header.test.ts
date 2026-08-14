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
