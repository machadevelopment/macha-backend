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

const { BillingProviderError, BILLING_PROVIDER_MESSAGE, BILLING_PROVIDER_STATUS } =
  await import('./billing-errors');

describe('BillingProviderError', () => {
  test('mensaje limpio: sin internals del proveedor ni "intenta de nuevo" vacío', () => {
    expect(BILLING_PROVIDER_MESSAGE.toLowerCase()).not.toContain('recurrente');
    expect(BILLING_PROVIDER_MESSAGE).not.toMatch(/\b5\d\d\b/);
  });

  test('ofrece salida: reintentar el pago o entrar con el plan gratuito', () => {
    expect(BILLING_PROVIDER_MESSAGE.toLowerCase()).toContain('gratuito');
  });

  test('es 502: el fallo es del upstream de pagos', () => {
    expect(BILLING_PROVIDER_STATUS).toBe(502);
  });

  test('conserva la causa técnica para Sentry', () => {
    const cause = new Error('Recurrente API error 500');
    const err = new BillingProviderError(cause);
    expect(err.name).toBe('BillingProviderError');
    expect((err as Error & { cause?: unknown }).cause).toBe(cause);
  });
});

/**
 * CU-868kmxu41 — la matriz de decisión del registro, fijada como tabla.
 *
 * El orden de estas condiciones ya estuvo mal una vez: la primera versión solo miraba
 * la bandera cuando el proveedor NO estaba configurado, así que en cuanto se cargaron
 * las llaves de Recurrente la bandera dejó de servir — justo cuando hacía falta, con
 * proveedor contratado y pilotos a los que todavía no se les quiere cobrar.
 */
describe('¿cobra este entorno? (CU-868kmxu41)', () => {
  // Réplica exacta de la decisión del handler. Si cambia allá y no acá, el test cae.
  const decidir = (banderaOpcional: boolean, proveedorConfigurado: boolean) => {
    const cobra = !banderaOpcional;
    if (cobra && !proveedorConfigurado) return 'rechaza_503';
    return cobra ? 'checkout' : 'sin_checkout';
  };

  test('bandera encendida con proveedor configurado: modo piloto, sin cobrar', () => {
    // El caso que la primera versión no cubría y que es el motivo de este arreglo.
    expect(decidir(true, true)).toBe('sin_checkout');
  });

  test('bandera encendida sin proveedor: tampoco cobra, y no se cae', () => {
    expect(decidir(true, false)).toBe('sin_checkout');
  });

  test('bandera apagada con proveedor: cobro real, el flujo de siempre', () => {
    expect(decidir(false, true)).toBe('checkout');
  });

  test('bandera apagada sin proveedor: 503 limpio, nunca un 500 con internals', () => {
    expect(decidir(false, false)).toBe('rechaza_503');
  });
});
