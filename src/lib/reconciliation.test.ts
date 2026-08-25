import { describe, expect, test } from 'bun:test';
import { medirFilas } from './reconciliation';
import type { ColumnMap } from './row-assembly';

const MAPA_VACIO: ColumnMap = {
  date: null,
  amount: null,
  currency: null,
  description: null,
  counterparty: null,
  product: null,
  quantity: null,
  productCategory: null,
  store: null,
  dueDate: null,
  costTotal: null,
  costUnit: null,
};

/**
 * La cifra que el cliente puede desmentir.
 *
 * El caso que lo motiva (2026-08-25): un cliente subió 19 meses de contabilidad y el dashboard
 * abrió en "este mes". Las cifras eran correctas al quetzal y aun así el reporte fue "esta data
 * no tiene absolutamente nada que ver con el Excel", porque contra los totales del archivo no
 * se parecían a nada. Con el total leído en el resumen, esa conversación dura dos segundos.
 */
describe('cuánto dinero traía la hoja', () => {
  const mapa: ColumnMap = { ...MAPA_VACIO, date: 0, amount: 2, product: 1 };

  test('suma la columna de monto de las filas enviadas', () => {
    const m = medirFilas(
      [
        [46000, 'Corolla', 117700],
        [46001, 'Sentra', 136800],
        [46002, 'Versa', 222700],
      ],
      mapa,
      'GTQ',
    );

    expect(m.filasEnviadas).toBe(3);
    expect(m.montos).toEqual([{ moneda: 'GTQ', total: 477200, filas: 3 }]);
  });

  /*
   * El monto entra en positivo por el mismo motivo que el pipeline lo exige positivo: la
   * dirección la lleva el tipo contable. Un archivo que escribe los gastos en negativo daría
   * un total que se cancela contra sus propios ingresos y el cliente vería una cifra que no es
   * ni sus ventas ni sus gastos.
   */
  test('un monto negativo suma en valor absoluto, no resta', () => {
    const m = medirFilas(
      [
        [46000, 'Venta', 1000],
        [46001, 'Gasto', -400],
      ],
      mapa,
      'GTQ',
    );
    expect(m.montos[0]!.total).toBe(1400);
  });

  test('una fila sin monto legible no aporta ni cuenta', () => {
    const m = medirFilas(
      [
        [46000, 'Corolla', 117700],
        [46001, 'TOTAL', 'no es un número'],
        [46002, 'Sentra', null],
      ],
      mapa,
      'GTQ',
    );

    // Las tres se ENVIARON; solo una traía dinero legible.
    expect(m.filasEnviadas).toBe(3);
    expect(m.montos).toEqual([{ moneda: 'GTQ', total: 117700, filas: 1 }]);
  });

  test('una hoja sin columna de monto no inventa un total', () => {
    const m = medirFilas([[1, 2, 3]], { ...MAPA_VACIO, date: 0 }, 'GTQ');
    expect(m.montos).toEqual([]);
    expect(m.filasEnviadas).toBe(1);
  });
});

/**
 * Sumar GTQ con USD daría un número que no es ninguna de las dos. En esta etapa las filas
 * todavía no tienen `amount_base` —la conversión pasa al promover, con la tasa por fila—, así
 * que no hay cifra convertida que sumar. Un dólar contado como quetzal subestima ~7,7 veces.
 */
describe('las monedas nunca se mezclan', () => {
  const mapa: ColumnMap = { ...MAPA_VACIO, amount: 1, currency: 2 };

  test('cada moneda lleva su propio total', () => {
    const m = medirFilas(
      [
        ['a', 1000, 'GTQ'],
        ['b', 200, 'USD'],
        ['c', 500, 'GTQ'],
      ],
      mapa,
      'GTQ',
    );

    expect(m.montos).toContainEqual({ moneda: 'GTQ', total: 1500, filas: 2 });
    expect(m.montos).toContainEqual({ moneda: 'USD', total: 200, filas: 1 });
  });

  test('la fila sin moneda usa la base de la empresa', () => {
    const m = medirFilas(
      [
        ['a', 1000, ''],
        ['b', 500, null],
      ],
      mapa,
      'USD',
    );
    expect(m.montos).toEqual([{ moneda: 'USD', total: 1500, filas: 2 }]);
  });

  /*
   * Un archivo real escribe `usd`, `USD` y `Usd` en la misma columna. Sin normalizar, el total
   * de UNA moneda se partiría en tres líneas que el cliente lee como tres monedas.
   */
  test('la misma moneda escrita distinto es una sola', () => {
    const m = medirFilas(
      [
        ['a', 100, 'usd'],
        ['b', 200, 'USD'],
        ['c', 300, ' Usd '],
      ],
      mapa,
      'GTQ',
    );
    expect(m.montos).toEqual([{ moneda: 'USD', total: 600, filas: 3 }]);
  });
});

/**
 * El costo va SEPARADO del monto, no sumado.
 *
 * En un libro de PYME el costo vive en su propia columna de la misma fila (`Costo Vehiculo (Q)`
 * al lado de `Precio Venta (Q)`). Mezclarlos daría un número que no es ni la venta ni el costo
 * — y es además la mitad que explica por qué el ledger tiene más filas que el archivo: esa
 * columna produce una segunda transacción.
 */
describe('el costo se mide aparte', () => {
  test('la venta con su costo en la misma fila da dos totales', () => {
    const m = medirFilas(
      [
        [46000, 117700, 99384],
        [46001, 136800, 121793],
      ],
      { ...MAPA_VACIO, date: 0, amount: 1, costTotal: 2 },
      'GTQ',
    );

    expect(m.montos).toEqual([{ moneda: 'GTQ', total: 254500, filas: 2 }]);
    expect(m.costos).toEqual([{ moneda: 'GTQ', total: 221177, filas: 2 }]);
  });

  test('el costo unitario se multiplica por las unidades', () => {
    const m = medirFilas(
      [[108, 6, 4.5]],
      { ...MAPA_VACIO, amount: 0, quantity: 1, costUnit: 2 },
      'GTQ',
    );
    expect(m.costos).toEqual([{ moneda: 'GTQ', total: 27, filas: 1 }]);
  });
});
