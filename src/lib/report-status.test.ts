import { describe, expect, test } from 'bun:test';
import { reportStatus } from '@/lib/report-status';

describe('reportStatus (CU-868ktkuq0)', () => {
  test('con versión está listo', () => {
    expect(reportStatus({ currentVersionId: 'v1', failedAt: null })).toBe('ready');
  });

  test('sin versión y sin marca, se está generando — no es un fallo', () => {
    // El caso del reporte: la fila existe desde antes de encolar el job, así que este es el
    // estado NORMAL de todo reporte recién pedido. Llamarlo "fallido" era el bug.
    expect(reportStatus({ currentVersionId: null, failedAt: null })).toBe('generating');
  });

  test('sin versión y con marca, falló', () => {
    expect(reportStatus({ currentVersionId: null, failedAt: new Date() })).toBe('failed');
  });

  test('la versión gana sobre una marca de fallo vieja', () => {
    // Un job puede fallar y reintentarse. `lib/reports.ts` limpia la marca en el mismo
    // update que escribe la versión, pero el orden de lectura tiene que aguantar igual si
    // esa limpieza no ocurriera: tener el reporte y que le digan que está roto es peor que
    // no tenerlo.
    expect(reportStatus({ currentVersionId: 'v1', failedAt: new Date() })).toBe('ready');
  });
});
