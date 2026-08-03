import { describe, expect, test } from 'bun:test';
import {
  counterCurrency,
  missingFxFlagReason,
  missingFxRateMessage,
  resolveFromCatalog,
  MISSING_FX_FLAG,
} from '@/lib/fx';

describe('resolución de tasa contra un catálogo cargado (CU-868kjc6h1)', () => {
  // Orden descendente por fecha, tal como lo devuelve loadFxCatalog.
  const catalogo = [
    { rate: 7.9, effectiveDate: '2026-03-01' },
    { rate: 7.75, effectiveDate: '2026-01-15' },
    { rate: 7.7, effectiveDate: '2025-12-01' },
  ];

  test('toma la más reciente que no sea posterior a la fecha', () => {
    expect(resolveFromCatalog(catalogo, '2026-02-10')?.rate).toBe(7.75);
  });

  test('la del mismo día vale (vigencia inclusiva)', () => {
    expect(resolveFromCatalog(catalogo, '2026-03-01')?.rate).toBe(7.9);
  });

  test('una fecha anterior a todo el catálogo no resuelve', () => {
    // El caso que antes tumbaba el documento entero: hay tasas, pero ninguna vigente
    // para esa fila. Ahora esa fila se marca y el resto de la carga sobrevive.
    expect(resolveFromCatalog(catalogo, '2025-06-30')).toBeNull();
  });

  test('catálogo vacío no resuelve nada', () => {
    expect(resolveFromCatalog([], '2026-02-10')).toBeNull();
  });
});

describe('mensajes accionables (CU-868kjc6h1 criterio 3)', () => {
  test('el error de promoción dice qué falta, para qué fecha y dónde arreglarlo', () => {
    const msg = missingFxRateMessage({ quote: 'USD', base: 'GTQ', onOrBefore: '2026-07-01' });
    expect(msg).toContain('USD→GTQ');
    expect(msg).toContain('2026-07-01');
    expect(msg).toContain('panel admin');
    // Lo que se fue: el uuid de la empresa, que no le sirve a quien lee el monitoreo.
    expect(msg).not.toContain('company');
  });

  test('el flag de staging conserva moneda y fecha para poder triarlo', () => {
    expect(missingFxFlagReason('USD', '2026-07-01')).toBe(`${MISSING_FX_FLAG}:USD:2026-07-01`);
  });
});

describe('par de monedas', () => {
  test('la contraparte de la base es la otra moneda soportada', () => {
    expect(counterCurrency('GTQ')).toBe('USD');
    expect(counterCurrency('USD')).toBe('GTQ');
  });
});
