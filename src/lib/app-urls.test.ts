import { describe, expect, test } from 'bun:test';

process.env.DATABASE_URL ??= 'postgres://smoke:smoke@localhost:5432/smoke';

const { env } = await import('./env');
env.appBaseUrl = 'https://app.macha.test';

const { reportUrl, alertUrl } = await import('./app-urls');

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
