import { describe, expect, test } from 'bun:test';

process.env.DATABASE_URL ??= 'postgres://smoke:smoke@localhost:5432/smoke';

const { computeAmountBase } = await import('./promotion');

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
