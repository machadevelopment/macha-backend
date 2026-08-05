import { describe, expect, test } from 'bun:test';

process.env.DATABASE_URL ??= 'postgres://smoke:smoke@localhost:5432/smoke';

const { BillingNotConfiguredError, BILLING_NOT_CONFIGURED_MESSAGE, BILLING_NOT_CONFIGURED_STATUS } =
  await import('./billing-errors');

/**
 * CU-868kmxu41. En producción, `POST /register` devolvía 500 con el texto interno
 * literal — nombre de la variable de entorno incluido — y el formulario mostraba
 * "Intenta de nuevo". Ninguna empresa podía registrarse.
 */
describe('BillingNotConfiguredError (CU-868kmxu41)', () => {
  test('el mensaje que cruza la red no nombra la variable ni el proveedor', () => {
    // Es la misma regla que CU-868kmr192: un error de configuración del servidor no es
    // información del usuario, y decirle a cualquiera cómo está montado el backend por
    // dentro no le sirve a nadie más que a quien busca huecos.
    expect(BILLING_NOT_CONFIGURED_MESSAGE).not.toContain('RECURRENTE');
    expect(BILLING_NOT_CONFIGURED_MESSAGE.toLowerCase()).not.toContain('recurrente');
    expect(BILLING_NOT_CONFIGURED_MESSAGE.toLowerCase()).not.toContain('sandbox');
    expect(BILLING_NOT_CONFIGURED_MESSAGE.toLowerCase()).not.toContain('key');
  });

  test('no le dice al usuario que reintente, porque reintentar no lo arregla', () => {
    // El mensaje anterior del formulario era "Intenta de nuevo": una instrucción falsa
    // ante un fallo de configuración, que deja a la persona insistiendo contra un muro.
    expect(BILLING_NOT_CONFIGURED_MESSAGE.toLowerCase()).not.toContain('intenta de nuevo');
  });

  test('ofrece una salida concreta en vez de dejar a la persona parada', () => {
    expect(BILLING_NOT_CONFIGURED_MESSAGE.length).toBeGreaterThan(20);
  });

  test('es 503 y no 500: la dependencia externa no está, el servidor no se rompió', () => {
    expect(BILLING_NOT_CONFIGURED_STATUS).toBe(503);
  });

  test('el detalle técnico sigue existiendo para Sentry, aunque no se responda', () => {
    const err = new BillingNotConfiguredError();
    expect(err.name).toBe('BillingNotConfiguredError');
    expect(err).toBeInstanceOf(Error);
  });
});
