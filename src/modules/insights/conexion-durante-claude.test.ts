import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════
 * EL CONSEJO DIARIO NO PUEDE SOSTENER UNA TRANSACCIÓN MIENTRAS CLAUDE ESCRIBE
 * ═══════════════════════════════════════════════════════════════════════════════════════
 *
 * Medido en producción 2026-08-28: el watchdog cerraba `POST /insights` a los 90 s
 * (tres veces esa mañana) y el único POST que llegó a responder fue un 503 en 3,6 s.
 * El botón del dashboard aborta a los 90 s. Las dos redes se encontraban.
 *
 * El worker de Excel ya deja la llamada al modelo FUERA de la transacción. Este
 * archivo fija que el consejo diario hace lo mismo: cierra la conexión del request
 * ANTES de llamar a Claude, y escribe el ledger en una transacción nueva.
 */

const src = readFileSync(join(import.meta.dir, 'index.ts'), 'utf-8');

describe('POST /insights no sostiene la transacción durante Claude', () => {
  test('cierra la conexión del request ANTES de llamar al modelo', () => {
    const cierre = src.indexOf('await cerrarPendiente(request, true)');
    const claude = src.indexOf('await generateInsightNarrative(');
    expect(cierre).toBeGreaterThan(-1);
    expect(claude).toBeGreaterThan(-1);
    expect(cierre).toBeLessThan(claude);
  });

  test('las escrituras van en una transacción nueva, no en la del request', () => {
    const claude = src.indexOf('await generateInsightNarrative(');
    const ledger = src.indexOf('await withCompanyScope(companyId', claude);
    expect(ledger).toBeGreaterThan(claude);
  });

  test('la señal de aborto del request llega a Claude', () => {
    expect(src).toContain('generateInsightNarrative(snapshot, localizedPrompt, request.signal)');
  });
});
