import { describe, expect, test } from 'bun:test';
import { asDate, assemblePayload, type ColumnMap, type RowVerdict } from './row-assembly';

/**
 * Estos tests son la red que hace SEGURO dejar de pedirle los valores al modelo.
 *
 * Antes el modelo devolvía la fila reconstruida y si se equivocaba se veía en revisión. Ahora
 * los valores los arma el código leyendo la celda que el mapa señala: si esta lógica falla,
 * falla en SILENCIO y con datos plausibles, que es mucho peor. Por eso se cubren los formatos
 * reales que traen los archivos del cliente, no casos de laboratorio.
 */

// Columnas reales de la hoja "Ventas" de los tres archivos de prueba (2026-08-12):
// IDOrden IDLinea FechaOrden IDTienda Canal IDCliente SKU Cantidad PrecioUnitario
// PorcentajeDescuento MetodoPago CostoUnitario Categoría TotalLinea UtilidadBruta MesOrden
const VENTAS_MAP: ColumnMap = {
  date: 2,
  amount: 13,
  currency: null,
  description: 6,
  counterparty: 5,
  product: 6,
  quantity: 7,
  productCategory: 12,
  dueDate: null,
};

const FILA_VENTA = [
  'ORD-00068','LIN-00001',45878,'TDA-002','En Tienda','CLI-0070','JYL-ARE-0023',2,272.99,0.1,'Transferencia Bancaria',135.52,'Aretes',491.382,220.342,'2025-08',
]; // prettier-ignore

const veredicto = (over: Partial<RowVerdict> = {}): RowVerdict => ({
  i: 0,
  targetEntity: 'transaction',
  type: 'revenue',
  category: 'ventas',
  confidence: 0.95,
  ...over,
});

describe('fecha de serie de Excel', () => {
  test('anclas conocidas de Excel', () => {
    // Estas dos son las referencias con las que se verifica cualquier conversión de serie
    // de Excel. Si estas pasan, la época y el bug del año bisiesto están bien puestos.
    expect(asDate(45292)).toBe('2024-01-01');
    expect(asDate(44927)).toBe('2023-01-01');
  });

  test('45878 es 2025-08-09 — y el propio archivo lo confirma', () => {
    // Los archivos reales traen las fechas como NÚMERO, no como texto. Convertirlo mal
    // desplazaría todos los movimientos del cliente en silencio.
    //
    // La fila de la que sale este serial trae además `MesOrden: "2025-08"`, o sea que el
    // archivo corrobora el mes por su cuenta. Es la comprobación cruzada que evita fijar
    // un valor calculado por la misma función que se está probando.
    expect(asDate(45878)).toBe('2025-08-09');
  });

  test('un MONTO en la columna de fecha no se convierte en fecha', () => {
    /*
     * El caso que este test descubrió, y por el que el rango técnico de Excel no sirve: el
     * serial 491 es 1901-05-05, una fecha válida. Así que un monto real de los archivos de
     * prueba (491.382) se convertía en una fecha creíble y entraba a la contabilidad del
     * cliente SIN marcarse — el peor modo de fallo posible: silencioso y plausible.
     *
     * El rango es de plausibilidad de NEGOCIO (1990-2100), no técnico.
     */
    expect(asDate(491.382)).toBe(null);
    expect(asDate(1234.5)).toBe(null);
    expect(asDate(1)).toBe(null);
    expect(asDate(0)).toBe(null);
    expect(asDate(999_999)).toBe(null);
  });

  test('pero las fechas reales del archivo sí pasan', () => {
    // Los seriales que de verdad aparecen en los tres archivos de prueba.
    expect(asDate(43409)).toBe('2018-11-05');
    expect(asDate(45063)).toBe('2023-05-17');
    expect(asDate(46231)).toBe('2026-07-28');
  });

  test('también acepta fecha real y texto', () => {
    expect(asDate(new Date('2026-08-12T00:00:00Z'))).toBe('2026-08-12');
    expect(asDate('2026-08-12')).toBe('2026-08-12');
    expect(asDate('no es fecha')).toBe(null);
    expect(asDate(null)).toBe(null);
  });
});

describe('montos', () => {
  const conMonto = (valor: unknown) =>
    assemblePayload({
      verdict: veredicto(),
      row: [valor],
      columns: { ...VENTAS_MAP, amount: 0, date: null },
      baseCurrency: 'GTQ',
    }).originalAmount;

  test('número nativo pasa tal cual', () => {
    expect(conMonto(491.382)).toBe(491.382);
  });

  test('texto con separador de miles', () => {
    expect(conMonto('Q 1,234.50')).toBe(1234.5);
    expect(conMonto('1,234.50')).toBe(1234.5);
  });

  test('formato con coma decimal', () => {
    // "1.234,50" es el formato de buena parte de Latinoamérica y Europa. Si se leyera como
    // separador de miles daría 123450 — un monto mil veces mayor, y creíble.
    expect(conMonto('1.234,50')).toBe(1234.5);
    expect(conMonto('1234,50')).toBe(1234.5);
  });

  test('negativos se conservan', () => {
    // Un exporte puede traer los gastos en negativo. Perder el signo invertiría el
    // resultado del cliente.
    expect(conMonto(-500)).toBe(-500);
    expect(conMonto('-1,500.00')).toBe(-1500);
  });

  test('lo que no es número da null, no un cero inventado', () => {
    // Un 0 pasaría como monto válido y entraría a producción. `null` marca la fila.
    expect(conMonto('N/A')).toBe(null);
    expect(conMonto('')).toBe(null);
    expect(conMonto(null)).toBe(null);
  });
});

describe('payload de transacción, con la fila real', () => {
  const payload = assemblePayload({
    verdict: veredicto(),
    row: FILA_VENTA,
    columns: VENTAS_MAP,
    baseCurrency: 'GTQ',
  });

  test('arma los nueve campos que espera aguas abajo', () => {
    // La forma NO cambia: `staging-rules.ts`, la promoción y la pantalla de revisión
    // siguen viendo exactamente lo mismo que antes. Cambia de dónde salen los valores.
    expect(Object.keys(payload).sort()).toEqual([
      'category','date','description','originalAmount','originalCurrency','product','productCategory','quantity','type',
    ]); // prettier-ignore
  });

  test('los valores salen de la celda que el mapa señala', () => {
    expect(payload.date).toBe('2025-08-09');
    expect(payload.originalAmount).toBe(491.382);
    expect(payload.quantity).toBe(2);
    expect(payload.product).toBe('JYL-ARE-0023');
    expect(payload.productCategory).toBe('Aretes');
  });

  test('el tipo y la categoría vienen del MODELO, no de la fila', () => {
    // Es la división del trabajo: el código indexa, el modelo juzga.
    expect(payload.type).toBe('revenue');
    expect(payload.category).toBe('ventas');
  });

  test('sin columna de moneda se usa la base de la empresa', () => {
    expect(payload.originalCurrency).toBe('GTQ');
    const enUsd = assemblePayload({
      verdict: veredicto(),
      row: FILA_VENTA,
      columns: VENTAS_MAP,
      baseCurrency: 'USD',
    });
    expect(enUsd.originalCurrency).toBe('USD');
  });
});

describe('bordes del mapa de columnas', () => {
  test('un índice fuera de rango da null, no revienta', () => {
    // El modelo puede señalar una columna que esa fila no tiene: las filas de un Excel no
    // siempre traen el mismo número de celdas.
    const p = assemblePayload({
      verdict: veredicto(),
      row: ['solo', 'dos'],
      columns: { ...VENTAS_MAP, amount: 99, date: 42 },
      baseCurrency: 'GTQ',
    });
    expect(p.originalAmount).toBe(null);
    expect(p.date).toBe(null);
  });

  test('columna ausente (null) se resuelve a null', () => {
    const p = assemblePayload({
      verdict: veredicto(),
      row: FILA_VENTA,
      columns: { ...VENTAS_MAP, quantity: null, product: null },
      baseCurrency: 'GTQ',
    });
    expect(p.quantity).toBe(null);
    expect(p.product).toBe(null);
  });

  test('quantity distingue null de 0', () => {
    // Cero unidades y "esta fila no habla de unidades" son cosas distintas: sobre la
    // segunda no se puede promediar. Antes era una instrucción del prompt; ahora lo
    // garantiza el código, que es estrictamente más fiable.
    const cero = assemblePayload({
      verdict: veredicto(),
      row: [0],
      columns: { ...VENTAS_MAP, quantity: 0, amount: null, date: null },
      baseCurrency: 'GTQ',
    });
    expect(cero.quantity).toBe(0);

    const ausente = assemblePayload({
      verdict: veredicto(),
      row: [''],
      columns: { ...VENTAS_MAP, quantity: 0, amount: null, date: null },
      baseCurrency: 'GTQ',
    });
    expect(ausente.quantity).toBe(null);
  });

  test('texto vacío nunca se cuela como categoría o descripción', () => {
    // `""` pasaría la validación de "hay categoría" de staging-rules sin serlo, y la fila
    // entraría a producción sin categoría real en vez de irse a revisión.
    const p = assemblePayload({
      verdict: veredicto({ category: null }),
      row: ['   '],
      columns: { ...VENTAS_MAP, description: 0, date: null, amount: null },
      baseCurrency: 'GTQ',
    });
    expect(p.description).toBe(null);
    expect(p.category).toBe(null);
  });

  test('sin tipo, cae a "other" y no a undefined', () => {
    // `undefined` desaparecería al serializar a JSONB y la fila quedaría sin `type`,
    // que `staging-rules` marca como inválida por una razón distinta de la real.
    const p = assemblePayload({
      verdict: veredicto({ type: null }),
      row: FILA_VENTA,
      columns: VENTAS_MAP,
      baseCurrency: 'GTQ',
    });
    expect(p.type).toBe('other');
  });
});

describe('payload de factura', () => {
  test('usa la forma AR/AP, no la de transacción', () => {
    const p = assemblePayload({
      verdict: veredicto({ targetEntity: 'invoice' }),
      row: ['FAC-001', 'Ferretería Los Pinos', 45878, 46000, 3200],
      columns: {
        date: 2,
        dueDate: 3,
        amount: 4,
        counterparty: 1,
        currency: null,
        description: null,
        product: null,
        quantity: null,
        productCategory: null,
      },
      baseCurrency: 'GTQ',
    });
    expect(Object.keys(p).sort()).toEqual([
      'counterparty',
      'dueDate',
      'issueDate',
      'originalAmount',
      'originalCurrency',
    ]);
    expect(p.counterparty).toBe('Ferretería Los Pinos');
    expect(p.issueDate).toBe('2025-08-09');
    expect(p.dueDate).toBe('2025-12-09');
    expect(p.originalAmount).toBe(3200);
  });
});
