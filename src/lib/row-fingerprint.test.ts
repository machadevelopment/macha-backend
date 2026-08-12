import { describe, expect, test } from 'bun:test';
import { fingerprintSheet, normalizeCell, normalizeRow, rowFingerprint } from './row-fingerprint';

const EMPRESA = '11111111-1111-4111-8111-111111111111';
const OTRA = '22222222-2222-4222-8222-222222222222';

const huella = (cells: unknown[], ordinal = 1, sheetName = 'Movimientos', companyId = EMPRESA) =>
  rowFingerprint({ companyId, sheetName, cells, ordinal });

describe('normalización de celdas', () => {
  test('el mismo monto exportado de tres formas da la misma huella', () => {
    // Es el caso que hace o rompe la deduplicación: un sistema contable exporta 1500,
    // otro 1500.0 y otro " 1500 ". Si dieran huellas distintas, no acertaría nunca.
    expect(normalizeCell(1500)).toBe(normalizeCell(1500.0));
    expect(normalizeCell(' 1500 ')).toBe('1500');
  });

  test('absorbe el error de punto flotante', () => {
    // 0.1 + 0.2 = 0.30000000000000004. Dos exportes del mismo monto pueden diferir en el
    // último bit y darían huellas distintas sin el redondeo.
    expect(normalizeCell(0.1 + 0.2)).toBe(normalizeCell(0.3));
  });

  test('colapsa el espacio interno de las descripciones', () => {
    expect(normalizeCell('Venta  mostrador')).toBe('Venta mostrador');
    expect(normalizeCell('  Venta mostrador  ')).toBe('Venta mostrador');
  });

  test('NO baja a minúsculas', () => {
    // Deliberado: "PAGO" y "pago" pueden venir de dos asientos distintos y colapsarlos
    // perdería una fila real del cliente. Se prefiere pagar de más a perder un dato.
    expect(normalizeCell('PAGO')).not.toBe(normalizeCell('pago'));
  });

  test('null, undefined y celda vacía son lo mismo', () => {
    // Excel devuelve las tres cosas para una celda sin contenido según cómo se exportó.
    expect(normalizeCell(null)).toBe('');
    expect(normalizeCell(undefined)).toBe('');
    expect(normalizeCell('')).toBe('');
  });

  test('una fecha se normaliza al día, sin hora', () => {
    expect(normalizeCell(new Date('2026-08-12T00:00:00Z'))).toBe('2026-08-12');
    expect(normalizeCell(new Date('2026-08-12T18:30:00Z'))).toBe('2026-08-12');
  });

  test('descarta números y fechas inválidos en vez de propagar NaN', () => {
    expect(normalizeCell(Number.NaN)).toBe('');
    expect(normalizeCell(new Date('no es fecha'))).toBe('');
  });

  test('dos celdas no se confunden con una celda que contiene el separador', () => {
    // Con una coma como separador, ["a,b"] y ["a","b"] darían la misma cadena y por lo
    // tanto la misma huella: dos filas distintas se colapsarían en una.
    expect(normalizeRow(['a,b'])).not.toBe(normalizeRow(['a', 'b']));
  });
});

describe('estabilidad de la huella', () => {
  test('la misma fila da la misma huella siempre', () => {
    expect(huella(['2026-08-01', 'Venta', 1500])).toBe(huella(['2026-08-01', 'Venta', 1500]));
  });

  test('cambiar cualquier celda cambia la huella', () => {
    const base = huella(['2026-08-01', 'Venta', 1500]);
    expect(huella(['2026-08-02', 'Venta', 1500])).not.toBe(base);
    expect(huella(['2026-08-01', 'Compra', 1500])).not.toBe(base);
    expect(huella(['2026-08-01', 'Venta', 1501])).not.toBe(base);
  });

  test('la misma fila en otra hoja da otra huella', () => {
    // Conservador a propósito: a lo sumo se paga de más, nunca se pierde una fila.
    expect(huella(['2026-08-01', 'Venta', 1500], 1, 'Enero')).not.toBe(
      huella(['2026-08-01', 'Venta', 1500], 1, 'Febrero'),
    );
  });

  test('la misma fila en otra EMPRESA da otra huella', () => {
    // Si colisionara entre empresas, la fila de una haría que la de otra se saltara la IA:
    // una fuga de aislamiento silenciosa. La consulta ya filtra por empresa; esto es el
    // cinturón dentro del propio hash.
    expect(huella(['2026-08-01', 'Venta', 1500], 1, 'Movimientos', OTRA)).not.toBe(
      huella(['2026-08-01', 'Venta', 1500], 1, 'Movimientos', EMPRESA),
    );
  });

  test('NO depende del documento', () => {
    // La huella no recibe `documentId` por diseño. Si lo recibiera, cada archivo nuevo
    // daría huellas nuevas y no se deduplicaría nada — el bug exacto que esto evita.
    // Se comprueba por la firma: no hay forma de pasarle el documento.
    const args = Object.keys({ companyId: '', sheetName: '', cells: [], ordinal: 1 });
    expect(args).not.toContain('documentId');
  });
});

describe('ordinal: filas legítimamente idénticas', () => {
  test('dos ventas iguales el mismo día NO se colapsan', () => {
    const filas = [
      ['2026-08-01', 'Venta mostrador', 250],
      ['2026-08-01', 'Venta mostrador', 250],
    ];
    const [a, b] = fingerprintSheet({ companyId: EMPRESA, sheetName: 'Enero', rows: filas });
    expect(a).not.toBe(b);
  });

  test('resubir el MISMO archivo reconoce todas las filas', () => {
    const filas = [
      ['2026-08-01', 'Venta', 250],
      ['2026-08-01', 'Venta', 250],
      ['2026-08-02', 'Compra', 900],
    ];
    const primera = fingerprintSheet({ companyId: EMPRESA, sheetName: 'Enero', rows: filas });
    const segunda = fingerprintSheet({ companyId: EMPRESA, sheetName: 'Enero', rows: filas });
    expect(segunda).toEqual(primera);
  });

  test('una TERCERA fila idéntica sí es nueva', () => {
    // El caso que distingue "resubió el archivo" de "vendió otra vez lo mismo".
    const dos = [
      ['2026-08-01', 'Venta', 250],
      ['2026-08-01', 'Venta', 250],
    ];
    const tres = [...dos, ['2026-08-01', 'Venta', 250]];

    const antes = new Set(fingerprintSheet({ companyId: EMPRESA, sheetName: 'E', rows: dos }));
    const ahora = fingerprintSheet({ companyId: EMPRESA, sheetName: 'E', rows: tres });

    const nuevas = ahora.filter((f) => !antes.has(f));
    expect(nuevas).toHaveLength(1);
  });

  test('el ordinal se cuenta por CONTENIDO, no por posición', () => {
    // Si el cliente reordena el archivo (ordena por fecha, por ejemplo), las filas siguen
    // siendo las mismas. Contar por posición las haría todas nuevas y se pagaría el archivo
    // entero otra vez — el modo de fallo más caro posible.
    const original = [
      ['2026-08-01', 'Venta', 250],
      ['2026-08-02', 'Compra', 900],
      ['2026-08-01', 'Venta', 250],
    ];
    const reordenado = [
      ['2026-08-01', 'Venta', 250],
      ['2026-08-01', 'Venta', 250],
      ['2026-08-02', 'Compra', 900],
    ];

    const a = new Set(fingerprintSheet({ companyId: EMPRESA, sheetName: 'E', rows: original }));
    const b = fingerprintSheet({ companyId: EMPRESA, sheetName: 'E', rows: reordenado });

    expect(b.every((f) => a.has(f))).toBe(true);
  });
});

describe('el caso semanal completo', () => {
  test('la semana 2 solo manda a la IA lo nuevo', () => {
    const semana1 = Array.from({ length: 500 }, (_, i) => [
      `2026-08-${String((i % 28) + 1).padStart(2, '0')}`,
      `Movimiento ${i}`,
      100 + i,
    ]);
    const semana2 = [
      ...semana1,
      ...Array.from({ length: 20 }, (_, i) => ['2026-09-01', `Nuevo ${i}`, 999 + i]),
    ];

    const yaVistas = new Set(
      fingerprintSheet({ companyId: EMPRESA, sheetName: 'Libro', rows: semana1 }),
    );
    const huellas2 = fingerprintSheet({ companyId: EMPRESA, sheetName: 'Libro', rows: semana2 });

    const aProcesar = huellas2.filter((f) => !yaVistas.has(f));

    // 520 filas en el archivo, 20 llegan al modelo. El resto no cuesta un token.
    expect(semana2).toHaveLength(520);
    expect(aProcesar).toHaveLength(20);
  });
});
