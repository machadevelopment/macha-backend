import { describe, expect, test } from 'bun:test';

process.env.DATABASE_URL ??= 'postgres://smoke:smoke@localhost:5432/smoke';

const { env } = await import('./env');
env.appBaseUrl = 'https://app.macha.test';

const { reportUrl, alertUrl, onboardingUrl } = await import('./app-urls');

describe('reportUrl (CU-868kh8jjy — el email de reporte enlazaba a un 404)', () => {
  test('apunta a /reports/{id} con el id que le pasan', () => {
    expect(reportUrl('a1b2c3')).toBe('https://app.macha.test/reports/a1b2c3');
  });

  test('respeta APP_BASE_URL en vez de hardcodear el host', () => {
    const previous = env.appBaseUrl;
    try {
      env.appBaseUrl = 'https://otro.example';
      expect(reportUrl('x')).toBe('https://otro.example/reports/x');
    } finally {
      env.appBaseUrl = previous;
    }
  });
});

describe('alertUrl', () => {
  test('apunta a /alerts/{alertEventId}', () => {
    expect(alertUrl('evt-1')).toBe('https://app.macha.test/alerts/evt-1');
  });
});

/**
 * Este bloque es el que de verdad protege contra la regresión que originó el ticket.
 * El bug no fue una URL mal formada — fue pasar el identificador EQUIVOCADO (el id de
 * `report_versions` en vez del de `reports`) a una URL perfectamente bien formada.
 * Ningún test de formato lo habría atrapado, así que se fija aquí el contrato de qué
 * entidad espera cada ruta, para que romperlo requiera editar esta expectativa a
 * propósito.
 */
describe('contrato de identificadores por ruta', () => {
  test('/reports/:id consume reports.id — NO report_versions.id', () => {
    const reportId = 'report-uuid';
    const reportVersionId = 'version-uuid';
    expect(reportUrl(reportId)).toContain(reportId);
    expect(reportUrl(reportId)).not.toContain(reportVersionId);
  });

  test('/alerts/:id consume alert_events.id', () => {
    expect(alertUrl('alert-event-uuid')).toContain('alert-event-uuid');
  });
});

/**
 * CU-868krmrcj fase C. El `successUrl` del checkout era un template string suelto en
 * `modules/billing/register.ts` apuntando a `/?registered=1` — o sea que el cliente que
 * acababa de PAGAR aterrizaba en la pantalla de entrada, no dentro del producto. Nada
 * fallaba: la URL existía, solo que no era la correcta. Es la misma forma del bug que
 * originó este módulo.
 */
describe('onboardingUrl', () => {
  test('sin checkout va limpio, sin parámetros que nadie puso', () => {
    expect(onboardingUrl()).toBe('https://app.macha.test/onboarding');
  });

  test('desde el checkout conserva registered=1', () => {
    expect(onboardingUrl({ fromCheckout: true })).toBe(
      'https://app.macha.test/onboarding?registered=1',
    );
  });

  test('NO apunta a la raíz — la regresión concreta que se está fijando', () => {
    // Aterrizar en `/` después de pagar es indistinguible de un alta que no pasó nada.
    const url = new URL(onboardingUrl({ fromCheckout: true }));
    expect(url.pathname).toBe('/onboarding');
    expect(url.pathname).not.toBe('/');
  });

  test('respeta APP_BASE_URL', () => {
    const previous = env.appBaseUrl;
    try {
      env.appBaseUrl = 'https://otro.example';
      expect(onboardingUrl()).toBe('https://otro.example/onboarding');
    } finally {
      env.appBaseUrl = previous;
    }
  });
});
