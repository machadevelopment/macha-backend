import { describe, expect, test } from 'bun:test';
import { analizarFormaDeHoja } from './sheet-shape';

/**
 * Los casos son los REALES de los archivos de clientes. Lo que se protege es el equilibrio:
 * atrapar los reportes que cuestan dinero SIN descartar una sola hoja de movimientos.
 *
 * Descartar de más es el error caro y silencioso: esa contabilidad no aparece en el dashboard
 * del cliente y nadie lo nota. Descartar de menos solo cuesta lo que ya cuesta hoy.
 */

const fila = (n: number, lleno: number): unknown[] =>
  Array.from({ length: n }, (_, i) => (i < lleno ? `v${i}` : null));

describe('reportes: las hojas que cuestan y no aportan', () => {
  test('una tabla dinámica por meses se reconoce', () => {
    /*
     * `Info MACRO 2026` de un archivo real: un bloque por mes pegado a lo ancho, cada uno con
     * sus títulos, el resto vacío. Le mandábamos 436 filas al modelo — es lo que hace que ese
     * archivo cueste USD 2,61 contra 1,84 de uno equivalente sin ella.
     */
    const encabezado = Array.from({ length: 60 }, (_, i) => (i % 12 === 0 ? `BLOQUE ${i}` : null));
    const hoja = [encabezado, ...Array.from({ length: 30 }, () => fila(60, 6))];
    expect(analizarFormaDeHoja(hoja).esReporte).toBe(true);
  });

  test('el motivo está en lenguaje del cliente, no en jerga', () => {
    // Va a `documents.error_reason`, que lee el dueño de una PYME. "Layout no tabular" no le
    // dice nada; "parece un reporte y no un listado de movimientos" sí.
    const encabezado = Array.from({ length: 60 }, (_, i) => (i % 12 === 0 ? `BLOQUE ${i}` : null));
    const hoja = [encabezado, ...Array.from({ length: 30 }, () => fila(60, 6))];
    const m = analizarFormaDeHoja(hoja).motivo;
    expect(m).toMatch(/reporte|tabla dinámica/);
    expect(m).not.toMatch(/null|layout|parse|schema/i);
  });
});

describe('tablas de verdad: ninguna se descarta', () => {
  test('una hoja de ventas normal pasa', () => {
    const hoja = [
      ['Fecha', 'Producto', 'Unidades', 'Ingreso', 'Costo'],
      ...Array.from({ length: 40 }, () => [46174, 'Café', 6, 108, 27]),
    ];
    expect(analizarFormaDeHoja(hoja).esReporte).toBe(false);
  });

  test('una tabla con columnas opcionales vacías NO es un reporte', () => {
    /*
     * La distinción que evita el falso positivo caro. Muchas celdas vacías por sí solas no
     * prueban nada: una tabla legítima tiene columnas opcionales y meses sin movimiento. Lo
     * que delata a un reporte es que su ANCHO no significa nada — las columnas son bloques de
     * layout, no campos repetidos fila a fila. Por eso se exige que las dos señales coincidan.
     */
    const hoja = [
      ['Fecha', 'Cliente', 'Producto', 'Monto', 'Nota', 'Referencia'],
      ...Array.from({ length: 40 }, () => [46174, 'Aldo', 'Café', 100, null, null]),
    ];
    expect(analizarFormaDeHoja(hoja).esReporte).toBe(false);
  });

  test('una hoja ancha pero bien rotulada pasa', () => {
    // 45 columnas, todas con nombre: es un volcado de sistema, no una dinámica. El ancho solo
    // no basta para descartar.
    const hoja = [
      Array.from({ length: 45 }, (_, i) => `Campo ${i}`),
      ...Array.from({ length: 20 }, () => fila(45, 45)),
    ];
    expect(analizarFormaDeHoja(hoja).esReporte).toBe(false);
  });

  test('una hoja chica nunca se descarta', () => {
    // Con pocas filas no hay geometría que juzgar, y tampoco cuesta nada mandarla.
    expect(
      analizarFormaDeHoja([
        ['a', null, null],
        [1, null, null],
      ]).esReporte,
    ).toBe(false);
  });
});
