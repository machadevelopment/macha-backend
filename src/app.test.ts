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

  /**
   * El formulario de la landing: primer endpoint de negocio sin JWT. Un 401 aquí significaría
   * que heredó un guard de inquilino y nadie podría pedir demo.
   * 422 = llegó al handler y TypeBox rechazó el cuerpo vacío (no 401).
   */
  test('POST /public/demo-requests llega al handler sin token (422, no 401)', async () => {
    const res = await call('/public/demo-requests', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res.status).not.toBe(401);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
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
    // Estas tres NO estaban acá, y por eso nadie notó que `/metrics/period` y
    // `/metrics/products` tenían su lógica escrita pero ninguna ruta montada: el frontend
    // las llamaba y recibía 404. Una ruta ausente da 404, no 401, así que esta lista es
    // exactamente lo que lo detecta.
    ['/metrics/period?from=2026-01-01&to=2026-01-31', undefined],
    ['/metrics/products?from=2026-01-01&to=2026-01-31', undefined],
    ['/metrics/categories?from=2026-01-01&to=2026-01-31', undefined],
    ['/ar-ap', undefined],
    // CU-868kt29t0, misma razón que las tres de arriba: una ruta escrita pero no montada
    // responde 404 y no 401, y esta lista es lo único que lo distingue.
    ['/ar-ap/counterparties', undefined],
    ['/inventory/', undefined],
    ['/inventory/movements', undefined],
    ['/inventory/', { method: 'POST', body: '{}' }],
    ['/inventory/00000000-0000-4000-8000-000000000000', { method: 'PATCH', body: '{}' }],
    ['/inventory/00000000-0000-4000-8000-000000000000/movements', { method: 'POST', body: '{}' }],
    ['/inventory/00000000-0000-4000-8000-000000000000', { method: 'DELETE' }],
    ['/insights', { method: 'POST', body: '{}' }],
    ['/credits/balance', undefined],
    ['/credits/topup/', { method: 'POST', body: '{}' }],
    ['/chats/', undefined],
    ['/reports/', undefined],
    // CU-B2-QA-20260811. Las tres rutas nuevas de reportes a demanda entran en esta lista
    // por la misma razón que `/metrics/period`: una ruta que existe en el módulo pero no
    // llegó a montarse responde 404, no 401, y este es el único test que lo distingue.
    ['/reports/catalog', undefined],
    ['/reports/generate', { method: 'POST', body: '{}' }],
    ['/reports/00000000-0000-4000-8000-000000000000/export/pdf', undefined],
    ['/alerts/', undefined],
    ['/alert-rules/', undefined],
    ['/alert-rules/ar_overdue', { method: 'PATCH', body: '{}' }],
    // El ledger fila por fila: el dato más sensible que sirve la app de cliente, así que
    // que exija token es justamente lo que no puede regresarse por un cambio de montaje.
    ['/transactions/', undefined],
    // Gestión de equipo (CU-868kh8pwv). La aceptación de invitación NO va acá: vive bajo
    // identityDerive porque quien acepta todavía no es miembro de ninguna empresa.
    ['/members/', undefined],
    ['/members/invitations', undefined],
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

  /**
   * CU-B4-QA-20260811. El catálogo del alta cuelga de `identityDerive` igual que el POST:
   * sesión verificada, sin exigir empresa. Se comprueba explícitamente porque un 401 es lo
   * que distingue "montada y protegida" de "no montada" (que daría 404) — y esta ruta es
   * fácil de dejar sin montar, porque vive en el mismo módulo que el POST y no en uno
   * propio.
   */
  test('GET /register/plans exige token', async () => {
    expect((await call('/register/plans')).status).toBe(401);
  });

  const adminScoped = [
    '/admin/companies/',
    '/admin/staging-rows/',
    '/admin/ai-cost',
    '/admin/demo-requests/',
    // CU-868kjc6h1: el catálogo de tasas cuelga de un módulo propio con su propio
    // `.use(adminGuard)` — si alguien lo montara sin guard, esto lo caza.
    '/admin/companies/00000000-0000-0000-0000-000000000000/fx-rates/',
    // CU-868kjc7g5: el ledger de créditos de una empresa, misma razón.
    '/admin/companies/00000000-0000-0000-0000-000000000000/credits/',
    /**
     * Ticket B5 — la vista consolidada. Exige token como todo `/admin/*`, y con más
     * motivo: la respuesta lleva el costo real en USD y los tokens consumidos, cifras de
     * plataforma que el cliente NUNCA debe ver.
     */
    '/admin/companies/overview',
  ];
  for (const path of adminScoped) {
    test(`GET ${path} exige token`, async () => {
      expect((await call(path)).status).toBe(401);
    });
  }
});

/**
 * Ticket B5 — la vista consolidada vive en `modules/admin/company-overview.ts`, un
 * módulo aparte que reusa el prefijo `/admin/companies` de `modules/admin/companies.ts`.
 * Eso pone `/overview` a competir con el `/:id` del detalle de empresa.
 *
 * La lista de arriba NO alcanza para cubrir esto: las dos rutas están detrás del mismo
 * guard, así que si `/overview` cayera en el handler de `/:id` el 401 saldría igual y
 * nadie se enteraría hasta ver un 404 de "Company not found" con id `overview` en
 * producción. Por eso se comprueba el REGISTRO de la ruta, que es lo que decide a qué
 * handler entra (el router de Elysia resuelve el segmento estático antes que el
 * dinámico).
 */
/**
 * ═══════════════════════════════════════════════════════════════════════════════════════
 * TODO ERROR SALE EN JSON — el contrato que el frontend asume en cada request
 * ═══════════════════════════════════════════════════════════════════════════════════════
 *
 * El fallo que lo motiva (producción, 2026-08-19): `tenant.derive.ts` respondió
 * `403 Not a member of the requested company` en TEXTO PLANO, y el proxy del BFF —que hace
 * `await res.json()`— explotó con `SyntaxError: Unexpected token 'N'`. El usuario vio un 500
 * opaco donde el backend había explicado exactamente qué pasaba.
 *
 * El contrato era inconsistente consigo mismo: los errores de negocio (`AiProviderError`,
 * `BillingProviderError`) ya devolvían `{ error }`, y los de guard no.
 */
describe('contrato de errores: siempre JSON', () => {
  test('un 401 de guard responde JSON, no texto plano', async () => {
    const res = await call('/documents/');
    expect(res.status).toBe(401);
    expect(res.headers.get('content-type')).toContain('application/json');
    const cuerpo = (await res.json()) as { error?: unknown };
    expect(typeof cuerpo.error).toBe('string');
  });

  test('el cuerpo se puede parsear siempre — que es lo que rompió en producción', async () => {
    // Exactamente lo que hace el BFF. Si esto lanza, el frontend devuelve un 500 sin
    // información en vez del status que el backend eligió.
    for (const path of ['/documents/', '/metrics', '/reports/', '/transactions/']) {
      const res = await call(path);
      expect(async () => await res.json()).not.toThrow();
    }
  });
});

describe('composición de /admin/companies (ticket B5)', () => {
  const paths = createApp().routes.map((r) => r.path);

  test('/admin/companies/overview está montada como ruta estática propia', () => {
    expect(paths).toContain('/admin/companies/overview');
  });

  test('el detalle por id sigue montado — la consolidada no lo reemplaza', () => {
    expect(paths).toContain('/admin/companies/:id');
  });
});
