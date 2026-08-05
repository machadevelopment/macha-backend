import { describe, expect, test } from 'bun:test';
import type { AiFailure } from './ai-errors';
import {
  AiProviderError,
  aiFailureMessage,
  aiFailureStatus,
  classifyAiError,
  runAi,
} from './ai-errors';

/**
 * CU-868kmr192. El caso que originó el ticket es el primero: Anthropic devuelve el saldo
 * agotado como un 400 `invalid_request_error`, no como 401 ni 402. Clasificarlo por
 * status lo dejaría en "error de programación nuestro" en vez de "nuestra cuenta no
 * tiene fondos", que es lo que realmente pasa y lo que decide el mensaje y el status.
 */
describe('clasificación del fallo del proveedor', () => {
  test('saldo agotado (400 real de Anthropic) es un problema NUESTRO, no del cliente', () => {
    const real = {
      status: 400,
      message:
        'Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.',
    };
    expect(classifyAiError(real)).toBe('not_configured');
    expect(aiFailureStatus(classifyAiError(real))).toBe(503);
  });

  const CASOS: Array<[unknown, AiFailure]> = [
    [{ status: 401 }, 'not_configured'],
    [{ status: 403 }, 'not_configured'],
    [{ status: 429 }, 'rate_limited'],
    [{ status: 413 }, 'too_large'],
    [{ status: 500 }, 'unavailable'],
    [{ status: 529 }, 'unavailable'],
    [{ status: 422 }, 'invalid'],
    [{ message: 'prompt is too long: 300000 tokens' }, 'too_large'],
    [new Error('fetch failed'), 'unavailable'],
  ];
  test.each(CASOS)('%o -> %s', (error, esperado) => {
    expect(classifyAiError(error)).toBe(esperado);
  });
});

describe('lo que ve el cliente', () => {
  test('ningún mensaje nombra al proveedor ni filtra detalles internos', () => {
    const prohibidas = [
      'anthropic',
      'claude',
      'api key',
      'billing',
      'request_id',
      'credit balance',
    ];
    for (const failure of [
      'not_configured',
      'unavailable',
      'rate_limited',
      'too_large',
      'invalid',
    ] as const) {
      const msg = aiFailureMessage(failure).toLowerCase();
      for (const p of prohibidas) expect(msg).not.toContain(p);
      expect(msg.length).toBeGreaterThan(20);
    }
  });

  test('un fallo nuestro NO se presenta como culpa del cliente (4xx)', () => {
    expect(aiFailureStatus('not_configured')).toBe(503);
    expect(aiFailureStatus('unavailable')).toBe(503);
    expect(aiFailureStatus('invalid')).toBe(503);
  });

  test('lo transitorio sí usa su status propio', () => {
    expect(aiFailureStatus('rate_limited')).toBe(429);
    expect(aiFailureStatus('too_large')).toBe(413);
  });
});

describe('runAi', () => {
  test('deja pasar el resultado cuando no hay error', async () => {
    expect(await runAi('prueba', async () => 42)).toBe(42);
  });

  test('convierte el error del SDK y conserva el original en `cause`', async () => {
    const original = { status: 429, message: 'rate limited' };
    const err = await runAi('insight_narrative', async () => {
      throw original;
    }).catch((e) => e);

    expect(err).toBeInstanceOf(AiProviderError);
    expect(err.failure).toBe('rate_limited');
    expect(err.operation).toBe('insight_narrative');
    expect(err.cause).toBe(original);
    // El mensaje del error interno no es el que se le enseña al cliente: ese sale de
    // aiFailureMessage() en el manejador global (src/app.ts).
    expect(err.message).not.toContain('rate limited');
  });

  test('no re-envuelve un AiProviderError que ya venía clasificado', async () => {
    const ya = new AiProviderError('unavailable', 'chat_turn');
    const err = await runAi('otro', async () => {
      throw ya;
    }).catch((e) => e);
    expect(err).toBe(ya);
  });
});
