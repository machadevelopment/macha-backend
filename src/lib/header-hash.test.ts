import { describe, expect, test } from 'bun:test';
import { encabezadosNormalizados, hashDeEncabezados } from './header-hash';

/**
 * CU-868krmrcj — la llave del perfil de mapeo por empresa.
 *
 * Lo que se prueba acá no es "el sha256 funciona": es la política de QUÉ cuenta como el mismo
 * layout. Equivocarse por el lado permisivo reutiliza un mapa sobre columnas que se movieron
 * —y entonces el monto se lee de la columna de fechas, con datos plausibles y sin un solo
 * error—. Equivocarse por el lado estricto tira el perfil en cada carga y el ahorro
 * desaparece en silencio.
 */

const VENTAS = ['Fecha', 'Producto', 'Cantidad', 'Precio Unitario (Q)', 'Ingreso Total (Q)'];

describe('el mismo layout da el mismo hash', () => {
  test('idéntico', () => {
    expect(hashDeEncabezados(VENTAS)).toBe(hashDeEncabezados(VENTAS));
  });

  test('mayúsculas, acentos y separadores no cuentan', () => {
    // El mismo Excel reexportado desde otro sistema. Si esto no casara, el cliente perdería
    // su perfil por un guion bajo.
    const otroExportador = ['FECHA', 'producto', 'CANTIDAD', 'precio_unitario', 'ingreso_total'];
    const conAcentos = ['Fecha', 'Producto', 'Cantidád', 'Precio Unitario', 'Ingreso Total'];

    expect(hashDeEncabezados(otroExportador)).toBe(
      hashDeEncabezados(['fecha', 'producto', 'cantidad', 'preciounitario', 'ingresototal']),
    );
    // "Cantidád" normaliza a "cantidad": el acento no cambia la columna.
    expect(hashDeEncabezados(conAcentos)).toBe(
      hashDeEncabezados(['Fecha', 'Producto', 'Cantidad', 'Precio Unitario', 'Ingreso Total']),
    );
  });

  test('la anotación de moneda entre paréntesis no cuenta', () => {
    // Rotular los montos con la moneda entre paréntesis es lo normal en Guatemala, y el
    // mismo libro puede traerla un año y no el siguiente.
    const conMoneda = ['Fecha', 'Ingreso Total (Q)'];
    const sinMoneda = ['Fecha', 'Ingreso Total'];
    expect(hashDeEncabezados(conMoneda)).toBe(hashDeEncabezados(sinMoneda));
  });
});

describe('un layout distinto da un hash distinto', () => {
  test('EL ORDEN IMPORTA — es el caso peligroso', () => {
    // Las mismas columnas movidas de sitio NO son el mismo layout: el mapa guarda ÍNDICES.
    // Reutilizarlo sobre columnas reordenadas leería el monto desde la columna de fechas.
    const reordenado = [
      'Producto',
      'Fecha',
      'Cantidad',
      'Precio Unitario (Q)',
      'Ingreso Total (Q)',
    ];
    expect(hashDeEncabezados(reordenado)).not.toBe(hashDeEncabezados(VENTAS));
  });

  test('una columna vacía intermedia corre los índices, así que cambia el hash', () => {
    const conHueco = [
      'Fecha',
      '',
      'Producto',
      'Cantidad',
      'Precio Unitario (Q)',
      'Ingreso Total (Q)',
    ];
    expect(hashDeEncabezados(conHueco)).not.toBe(hashDeEncabezados(VENTAS));
  });

  test('una columna de más cambia el hash', () => {
    expect(hashDeEncabezados([...VENTAS, 'Costo Total (Q)'])).not.toBe(hashDeEncabezados(VENTAS));
  });

  test('dos encabezados no se pueden concatenar al mismo material', () => {
    // El separador es `|`, que `normalizeHeader` no puede producir (solo devuelve [a-z0-9]).
    // Sin un separador imposible, ['ab','c'] y ['a','bc'] darían el mismo hash.
    expect(hashDeEncabezados(['ab', 'c'])).not.toBe(hashDeEncabezados(['a', 'bc']));
  });
});

describe('encabezadosNormalizados', () => {
  test('conserva el orden y la posición de los vacíos', () => {
    // Los vacíos se conservan, no se filtran: son lo que corre los índices siguientes.
    expect(encabezadosNormalizados(['Fecha', '', 'Producto'])).toEqual(['fecha', '', 'producto']);
  });

  test('sobrevive a celdas que no son texto', () => {
    // Un encabezado puede venir como número o vacío desde SheetJS; no debe reventar.
    expect(encabezadosNormalizados([2026, null, undefined, 'Total'])).toEqual([
      '2026',
      '',
      '',
      'total',
    ]);
  });

  test('produce exactamente el material que hashea', () => {
    // Si las dos funciones divergieran, lo que se guarda para diagnosticar no describiría lo
    // que se usó como llave — y el diagnóstico mentiría justo cuando se necesita.
    const normalizados = encabezadosNormalizados(VENTAS);
    expect(hashDeEncabezados(VENTAS)).toBe(hashDeEncabezados(normalizados));
  });
});
