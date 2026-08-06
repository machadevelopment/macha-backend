import { describe, expect, test } from 'bun:test';

process.env.DATABASE_URL ??= 'postgres://smoke:smoke@localhost:5432/smoke';

const { computeAmountBase, normalizeQuantity } = await import('./promotion');

describe('normalizeQuantity (unidades de la fila -> columna numeric)', () => {
  test('un número positivo se guarda como string, no como float', () => {
    expect(normalizeQuantity(12)).toBe('12');
    // Fraccionaria a propósito: aquí se vende por libra y por metro, no solo por unidad.
    expect(normalizeQuantity(2.5)).toBe('2.5');
  });

  test('sin cantidad es NULL, y NULL no es 0', () => {
    // "Esta fila no habla de unidades" (un alquiler, un total) es distinto de "se
    // vendieron 0". Sobre lo primero no se puede promediar un ticket.
    expect(normalizeQuantity(null)).toBeNull();
    expect(normalizeQuantity(undefined)).toBeNull();
  });

  test('un valor imposible degrada a NULL en vez de tumbar la carga entera', () => {
    // La promoción es atómica: si esto dejara pasar un 0 o un negativo, el CHECK de la
    // migración 0019 rechazaría el INSERT y una fila con un campo accesorio malo se
    // llevaría el documento completo. La cantidad es enriquecimiento; el movimiento
    // financiero de esa fila sí sirve.
    expect(normalizeQuantity(0)).toBeNull();
    expect(normalizeQuantity(-3)).toBeNull();
    expect(normalizeQuantity(Number.NaN)).toBeNull();
    expect(normalizeQuantity(Number.POSITIVE_INFINITY)).toBeNull();
    expect(normalizeQuantity('8' as unknown as number)).toBeNull();
  });
});

describe('computeAmountBase (CU-868kfva9z — dinero en numeric, nunca float)', () => {
  test('moneda igual a la base (fxRate=1) deja el monto intacto', () => {
    expect(computeAmountBase(1500, 1)).toBe('1500');
  });

  test('aplica la tasa de cambio', () => {
    expect(computeAmountBase(100, 7.8)).toBe('780');
  });

  test('preserva decimales sin redondear silenciosamente', () => {
    expect(computeAmountBase(33.33, 1.5)).toBe(String(33.33 * 1.5));
  });

  test('monto cero resuelve a "0", no a string vacío/NaN', () => {
    expect(computeAmountBase(0, 7.8)).toBe('0');
  });
});
