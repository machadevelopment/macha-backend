import { describe, expect, test } from 'bun:test';
import { hashDeOrigen, ipDeCabeceras } from '@/lib/lead-origin';

describe('ipDeCabeceras', () => {
  test('toma el primer valor de x-forwarded-for, no el del proxy', () => {
    expect(ipDeCabeceras({ 'x-forwarded-for': '203.0.113.9, 10.0.0.1, 10.0.0.2' })).toBe(
      '203.0.113.9',
    );
  });

  test('cae a x-real-ip y luego a desconocido', () => {
    expect(ipDeCabeceras({ 'x-real-ip': '198.51.100.4' })).toBe('198.51.100.4');
    expect(ipDeCabeceras({})).toBe('desconocido');
  });
});

describe('hashDeOrigen', () => {
  test('es estable para la misma IP y distinto entre IPs', () => {
    const a = hashDeOrigen('203.0.113.9');
    const b = hashDeOrigen('203.0.113.9');
    const c = hashDeOrigen('198.51.100.4');
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });
});
