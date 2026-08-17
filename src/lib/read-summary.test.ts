import { describe, expect, test } from 'bun:test';
import { columnasEnPalabras, construirResumen, ordenarHojas, type HojaLeida } from './read-summary';
import type { ColumnMap } from './row-assembly';

/**
 * CU-868krmrcj — el resumen de lectura.
 *
 * Existe para que los dos fallos silenciosos de la ingesta dejen de serlo: leer el monto de la
 * columna equivocada, y descartar hojas sin decirlo. Lo que estos tests protegen es que el
 * resumen sea LEGIBLE por el dueño de una PYME — si no lo es, no sirve para nada, porque su
 * única función es que él pueda desmentirlo.
 */

const MAPA: ColumnMap = {
  date: 0,
  amount: 4,
  currency: null,
  description: null,
  counterparty: null,
  product: 1,
  quantity: 2,
  productCategory: null,
  dueDate: null,
  costTotal: 5,
  costUnit: null,
};

const HEADER = [
  'Fecha',
  'Producto',
  'Cantidad',
  'Precio Unitario (Q)',
  'Ingreso Total (Q)',
  'Costo Total (Q)',
];

describe('columnasEnPalabras', () => {
  test('traduce índices a los ENCABEZADOS REALES del archivo', () => {
    // `{"amount": 4}` no le dice nada a nadie. Que diga "Ingreso Total (Q)" es lo único que
    // permite al dueño responder "esa no es la columna".
    const cols = columnasEnPalabras(MAPA, HEADER);
    expect(cols['monto']).toBe('Ingreso Total (Q)');
    expect(cols['fecha']).toBe('Fecha');
    expect(cols['producto']).toBe('Producto');
    expect(cols['costo de la línea']).toBe('Costo Total (Q)');
  });

  test('usa nombres de campo en el idioma del DUEÑO, no del esquema', () => {
    // "counterparty" y "productCategory" no significan nada para quien lleva la contabilidad
    // de una cafetería.
    const cols = columnasEnPalabras({ ...MAPA, counterparty: 3, productCategory: 1 }, HEADER);
    expect(Object.keys(cols)).toContain('cliente o proveedor');
    expect(Object.keys(cols)).toContain('categoría del producto');
    expect(Object.keys(cols)).not.toContain('counterparty');
  });

  test('OMITE los campos que la hoja no trae, en vez de llenarlos de nulos', () => {
    // Un resumen con once líneas de las que ocho dicen "no traía" es ruido. El dueño necesita
    // ver de un vistazo las cuatro que sí importan.
    const cols = columnasEnPalabras(MAPA, HEADER);
    expect(Object.keys(cols)).not.toContain('moneda');
    expect(Object.keys(cols)).not.toContain('fecha de vencimiento');
    expect(Object.keys(cols).length).toBe(5);
  });

  test('un índice fuera de rango se omite: no se inventa precisión', () => {
    // Si el modelo señaló una columna que no existe, decir "columna 13" sería afirmar algo
    // que el cliente no puede ir a comprobar en su archivo.
    const cols = columnasEnPalabras({ ...MAPA, amount: 99 }, HEADER);
    expect(Object.keys(cols)).not.toContain('monto');
  });

  test('un encabezado en blanco cae al número de columna, no desaparece', () => {
    // Peor que un nombre, mucho mejor que omitirlo: "el monto salió de la columna 5" al menos
    // se puede ir a mirar.
    const sinNombre = ['Fecha', '', '', '', ''];
    const cols = columnasEnPalabras({ ...MAPA, amount: 4 }, sinNombre);
    expect(cols['monto']).toBe('columna 5');
  });
});

describe('ordenarHojas', () => {
  const hojas: HojaLeida[] = [
    { estado: 'descartada', nombre: 'Clientes', motivo: 'catalogo', filas: 101 },
    { estado: 'movimientos', nombre: 'Ventas', filas: 520, columnas: {} },
    { estado: 'descartada', nombre: 'LineasOC', motivo: 'duplica_otra_hoja', filas: 221 },
    {
      estado: 'inventario',
      nombre: 'Inventario',
      creados: 211,
      ajustados: 0,
      sinCambio: 0,
      omitidas: 0,
    },
  ];

  test('primero lo que produjo datos, después lo descartado', () => {
    const orden = ordenarHojas(hojas).map((h) => h.nombre);
    expect(orden.slice(0, 2).sort()).toEqual(['Inventario', 'Ventas']);
    expect(orden.slice(2)).toEqual(['LineasOC', 'Clientes']);
  });

  test('dentro de los descartes, primero el que más filas se comió', () => {
    // Si el pre-filtro tiró 221 filas de una hoja, eso es lo primero que el cliente tiene que
    // poder cuestionar. Con orden alfabético quedaría enterrado entre hojas de seis filas.
    const descartadas = ordenarHojas(hojas).filter((h) => h.estado === 'descartada');
    expect(descartadas.map((h) => h.nombre)).toEqual(['LineasOC', 'Clientes']);
  });

  test('no muta el arreglo que recibe', () => {
    const copia = [...hojas];
    ordenarHojas(hojas);
    expect(hojas).toEqual(copia);
  });
});

describe('construirResumen', () => {
  test('conserva los totales tal cual y ordena las hojas', () => {
    const r = construirResumen(
      [
        { estado: 'descartada', nombre: 'Clientes', motivo: 'catalogo', filas: 101 },
        { estado: 'movimientos', nombre: 'Ventas', filas: 520, columnas: {} },
      ],
      { movimientos: 520, descartadas: 589, yaIngeridas: 0 },
    );
    expect(r.totales).toEqual({ movimientos: 520, descartadas: 589, yaIngeridas: 0 });
    expect(r.hojas[0]!.nombre).toBe('Ventas');
  });

  test('"ya ingerida" es un estado propio, distinto de descartada por el pre-filtro', () => {
    /*
     * Para el cliente son cosas muy distintas: "no leí esta hoja" contra "ya la tenía
     * completa". La segunda es el caso de ÉXITO de la deduplicación y cuesta USD 0; mostrarla
     * como descarte haría que su resubida semanal pareciera un fallo cada lunes.
     */
    const r = construirResumen(
      [{ estado: 'descartada', nombre: 'Ventas', motivo: 'ya_ingerida', filas: 520 }],
      { movimientos: 0, descartadas: 0, yaIngeridas: 520 },
    );
    const hoja = r.hojas[0]!;
    expect(hoja.estado === 'descartada' && hoja.motivo).toBe('ya_ingerida');
    expect(r.totales.descartadas).toBe(0);
    expect(r.totales.yaIngeridas).toBe(520);
  });
});
