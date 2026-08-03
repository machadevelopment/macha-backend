import { describe, expect, test } from 'bun:test';
import { createApp } from '@/app';

/**
 * Regresión de COMPOSICIÓN, no de guards.
 *
 * EL FALLO QUE FIJA ESTE ARCHIVO. Los tres guards terminaban en `.as('global')`. En
 * Elysia ese scope propaga el `derive` al padre y a todas las rutas montadas después,
 * no solo a las del módulo que hace `.use(guard)`. Como `src/app.ts` monta `ingestion`
 * (que arrastra `tenantDerive`) antes que el resto, TODO lo montado después heredaba la
 * autenticación de inquilino:
 *
 *   POST /webhooks/recurrente -> 401   (Recurrente firma con svix, nunca manda bearer:
 *                                       ningún pago se conciliaba, ningún top-up
 *                                       acreditaba créditos, ninguna suscripción se
 *                                       activaba)
 *   POST /register            -> 401   (lo bloqueaba el guard que exige la membresía
 *                                       que /register existe para crear)
 *   GET  /admin/companies     -> 401   (y con token, tenantDerive corría ANTES del gate
 *                                       de staff, reservando dos conexiones por request)
 *   GET  /                    -> 401
 *
 * POR QUÉ NO LO VIO NADA. `bun test src` y `test:integration` estaban en verde. Los de
 * integración ejercitan los guards CONTRA LA BASE (RLS, GUC, aislamiento por inquilino);
 * ninguno monta la app y la llama por HTTP. El defecto no estaba en ningún guard: estaba
 * en cómo se combinan. Por eso este test usa `createApp()` —la composición real que se
 * despliega— y no una lista de módulos copiada aquí, que se desincronizaría al primer
 * módulo nuevo.
 *
 * Ninguna de estas llamadas toca Postgres: las rutas guardadas cortan en el guard antes
 * de consultar nada, y las públicas que se ejercitan responden antes de usar `db`.
 */

const app = createApp();

const call = (path: string, init?: RequestInit) =>
  app.handle(new Request(`http://localhost${path}`, init));

/** Rutas fuera de toda cadena de guards: deben responder SIN cabecera Authorization. */
describe('rutas públicas — ningún guard debe alcanzarlas', () => {
  test('GET /health/ responde sin token', async () => {
    const res = await call('/health/');
    expect(res.status).toBe(200);
  });

  test('GET / responde sin token', async () => {
    const res = await call('/');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ service: 'macha-backend' });
  });

  /**
   * El criterio central del ticket. Un 401 aquí significa que el request murió en un
   * guard de inquilino y `verifyAndParseWebhook` nunca corrió. El 400 prueba que llegó
   * al handler y falló donde debe: por falta de cabeceras svix.
   */
  test('POST /webhooks/recurrente llega al handler (400 por svix, no 401)', async () => {
    const res = await call('/webhooks/recurrente/', { method: 'POST', body: '{}' });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Missing svix headers' });
  });

  /**
   * Contraprueba de que sobre el webhook no corre NINGÚN guard: si corriera alguno,
   * un bearer inválido daría 401/500 al verificarlo contra JWKS en vez de 400.
   */
  test('POST /webhooks/recurrente ignora un bearer inválido y sigue dando 400', async () => {
    const res = await call('/webhooks/recurrente/', {
      method: 'POST',
      body: '{}',
      headers: { authorization: 'Bearer no-es-un-jwt' },
    });
    expect(res.status).toBe(400);
  });
});

/**
 * La otra mitad, y la que hace que este test no sea peligroso: aflojar el scope no
 * puede dejar ninguna ruta de negocio sin autenticar. Si un `.use(guard)` se pierde en
 * un módulo, el 401 se convierte en 200/500 y esto falla.
 */
describe('rutas guardadas — 401 sin token', () => {
  const tenantScoped: Array<[string, RequestInit | undefined]> = [
    ['/documents/', undefined],
    ['/documents/abc', undefined],
    ['/industry-templates/download', undefined],
    ['/metrics', undefined],
    ['/ar-ap', undefined],
    ['/insights', { method: 'POST', body: '{}' }],
    ['/credits/balance', undefined],
    ['/credits/topup/', { method: 'POST', body: '{}' }],
    ['/chats/', undefined],
    ['/reports/', undefined],
    ['/alerts/', undefined],
    ['/alert-rules/', undefined],
    ['/alert-rules/ar_overdue', { method: 'PATCH', body: '{}' }],
  ];

  for (const [path, init] of tenantScoped) {
    test(`${init?.method ?? 'GET'} ${path} exige token`, async () => {
      expect((await call(path, init)).status).toBe(401);
    });
  }

  const identityScoped = ['/me/memberships'];
  for (const path of identityScoped) {
    test(`GET ${path} exige token`, async () => {
      expect((await call(path)).status).toBe(401);
    });
  }

  test('POST /register exige token', async () => {
    expect((await call('/register/', { method: 'POST', body: '{}' })).status).toBe(401);
  });

  const adminScoped = ['/admin/companies/', '/admin/staging-rows/', '/admin/ai-cost'];
  for (const path of adminScoped) {
    test(`GET ${path} exige token`, async () => {
      expect((await call(path)).status).toBe(401);
    });
  }
});
