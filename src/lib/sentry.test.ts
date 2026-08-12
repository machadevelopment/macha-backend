import { describe, expect, test } from 'bun:test';
import { evaluateSentry, type SentryInputs } from './sentry';

/**
 * CU-868kmr1tb. Dos regresiones distintas, las dos invisibles:
 *
 *  1. Producción arrancando sin DSN sin que nadie se entere (así llegó el repo a este
 *     ticket: cliente real servido durante días sin una sola captura de errores).
 *  2. Staging y producción etiquetando sus eventos con el mismo `environment`, porque
 *     ambos corren con `NODE_ENV=production`. Un tablero de Sentry que mezcla los dos
 *     entornos es peor que no tenerlo: da la sensación de estar mirando.
 */

const DSN = 'https://0123456789abcdef0123456789abcdef@o1.ingest.sentry.io/2';

function inputs(over: Partial<SentryInputs> = {}): SentryInputs {
  return {
    dsn: '',
    sentryEnvironment: '',
    railwayEnvironment: '',
    nodeEnv: 'development',
    ...over,
  };
}

describe('evaluateSentry — cuándo se grita', () => {
  test('local sin DSN: no arranca y NO avisa (es el estado normal)', () => {
    const s = evaluateSentry(inputs());
    expect(s.enabled).toBe(false);
    expect(s.warning).toBeNull();
  });

  test('el job de tests (NODE_ENV=test) sin DSN tampoco avisa', () => {
    expect(evaluateSentry(inputs({ nodeEnv: 'test' })).warning).toBeNull();
  });

  test('un deploy de Railway sin DSN avisa, aunque NODE_ENV no diga production', () => {
    const s = evaluateSentry(inputs({ railwayEnvironment: 'staging', nodeEnv: 'development' }));
    expect(s.enabled).toBe(false);
    expect(s.warning).toContain('SIN MONITOREO DE ERRORES');
    expect(s.warning).toContain('staging');
  });

  test('NODE_ENV=production sin DSN avisa aunque no haya señales de Railway', () => {
    expect(evaluateSentry(inputs({ nodeEnv: 'production' })).warning).toContain(
      'SIN MONITOREO DE ERRORES',
    );
  });

  test('con DSN arranca y no avisa', () => {
    const s = evaluateSentry(inputs({ dsn: DSN, nodeEnv: 'production' }));
    expect(s.enabled).toBe(true);
    expect(s.warning).toBeNull();
  });

  test('una variable presente pero VACÍA es ausencia, no un DSN', () => {
    // El estado normal de Railway/Vercel al guardar la clave sin valor (ver env.ts).
    expect(evaluateSentry(inputs({ dsn: '', nodeEnv: 'production' })).enabled).toBe(false);
  });
});

describe('evaluateSentry — de dónde sale el `environment`', () => {
  test('staging y producción NO se confunden pese a compartir NODE_ENV=production', () => {
    const prod = evaluateSentry(
      inputs({ dsn: DSN, railwayEnvironment: 'production', nodeEnv: 'production' }),
    );
    const staging = evaluateSentry(
      inputs({ dsn: DSN, railwayEnvironment: 'staging', nodeEnv: 'production' }),
    );
    expect(prod.environment).toBe('production');
    expect(staging.environment).toBe('staging');
    expect(prod.environment).not.toBe(staging.environment);
  });

  test('SENTRY_ENVIRONMENT gana sobre la variable de Railway y sobre NODE_ENV', () => {
    const s = evaluateSentry(
      inputs({
        dsn: DSN,
        sentryEnvironment: 'canary',
        railwayEnvironment: 'production',
        nodeEnv: 'production',
      }),
    );
    expect(s.environment).toBe('canary');
  });

  test('sin señales de plataforma cae a NODE_ENV', () => {
    expect(evaluateSentry(inputs({ dsn: DSN, nodeEnv: 'production' })).environment).toBe(
      'production',
    );
  });

  test('sin nada resuelve development, nunca cadena vacía', () => {
    expect(evaluateSentry(inputs({ nodeEnv: '' })).environment).toBe('development');
  });
});
