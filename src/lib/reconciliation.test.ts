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

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * EL RENGLÓN DE TOTAL DUPLICABA EL DINERO DEL PORTÓN (reporte de Keneth, 2026-09-03)
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *
 * *"En el primer Excel me dice que son 140 pero en la web me salía 280."*
 *
 * Un total es POR DEFINICIÓN la suma de las filas de arriba, así que medirlo reporta
 * exactamente el DOBLE. Reproducido al centavo sobre `Jewelry_Store_Template11.xlsx`, un
 * archivo real de cliente: las CINCO hojas de dinero daban ×2 exacto.
 *
 * ⚠️ El daño es específico del PORTÓN, y eso es lo que lo hace grave: esa pantalla existe para
 * que el dueño pueda DESMENTIRNOS antes de publicar. Enseñarle el doble de su facturación lo
 * deja eligiendo entre aprobar una cifra falsa o no aprobar su contabilidad correcta.
 *
 * Las filas son las del archivo real, con su forma exacta — el rótulo alineado a la derecha,
 * pegado a la cifra, con todo lo de la izquierda en blanco. Escribirlas "prolijas" (rótulo en
 * la columna 0) haría pasar el test sin cubrir el caso que ocurrió.
 */
describe('⚠️ el renglón de TOTAL no se mide', () => {
  const columnas = (over: Partial<ColumnMap>): ColumnMap => ({ ...MAPA_VACIO, ...over });

  test('`TOTAL SALES` en la columna 7 no suma (era ×2 exacto)', () => {
    const filas: unknown[][] = [
      ['SO-2001', 46027, 'CU-005', 'Corporate Gifts LLC', 'JW-1013', 'Rose Gold Bangle', 1, 440, 440],
      ['SO-2002', 46027, 'CU-002', 'James Whitfield', 'JW-1007', 'Charm Bracelet', 1, 130, 130],
      // La fila real del archivo: siete celdas vacías, el rótulo, la cifra.
      ['', '', '', '', '', '', '', 'TOTAL SALES', 570],
    ]; // prettier-ignore
    const m = medirFilas(filas, columnas({ amount: 8 }), 'USD');
    expect(m.montos[0]?.total).toBe(570);
  });

  test('⚠️ `TOTALS` en PLURAL INGLÉS tampoco: era la otra mitad del bug', () => {
    /*
     * El regex tenía `totales` —el plural ESPAÑOL— y el `\b` hacía que `total` seguido de `s`
     * no cerrara palabra. O sea que el rótulo más común de una plantilla en inglés no se
     * reconocía, ni acá ni en los otros dos filtros que comparten la función. Es lo que dejaba
     * pasar `Accounts Receivable` y `Accounts Payable` del archivo real.
     */
    const filas: unknown[][] = [
      ['INV-6001', 'CU-005', 46027, 46072, 440, 440, 0],
      ['INV-6002', 'CU-002', 46027, 46087, 130, 130, 0],
      ['', '', '', 'TOTALS', 570, 570, 0],
    ];
    const m = medirFilas(filas, columnas({ amount: 4 }), 'USD');
    expect(m.montos[0]?.total).toBe(570);
  });

  test('una fila normal cuyo TEXTO menciona un total SÍ se mide', () => {
    /*
     * La guarda mira la primera celda NO VACÍA, no cualquier celda, y esta es la diferencia
     * que eso protege: un movimiento real cuya descripción diga "Pago total a proveedor" es
     * plata del cliente. Un falso positivo acá la esconde, que es peor que el bug original —
     * el doble se ve, lo que falta no.
     */
    const filas: unknown[][] = [['2026-01-05', 'Pago total a proveedor', 1200]];
    const m = medirFilas(filas, columnas({ amount: 2 }), 'USD');
    expect(m.montos[0]?.total).toBe(1200);
  });

  test('el COSTO de la fila de total tampoco se cuenta', () => {
    // `medirFilas` mide dos cosas y la exclusión tiene que alcanzar a las dos, o la hoja de
    // ventas con costo en la línea seguiría reportando el doble por la otra mitad.
    const filas: unknown[][] = [
      ['V-1', 46027, 500, 300],
      ['', 'TOTALES', 500, 300],
    ];
    const m = medirFilas(filas, columnas({ amount: 2, costTotal: 3 }), 'USD');
    expect(m.montos[0]?.total).toBe(500);
    expect(m.costos[0]?.total).toBe(300);
  });
});
