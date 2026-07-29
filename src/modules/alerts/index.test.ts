import { describe, expect, test } from 'bun:test';

// Mismo patrón que modules/health/index.test.ts: db/client.ts valida DATABASE_URL al
// importar, y postgres.js conecta de forma perezosa, así que una URL válida pero
// inalcanzable basta mientras el test no llegue a tocar la base.
process.env.DATABASE_URL ??= 'postgres://smoke:smoke@localhost:5432/smoke';
process.env.WORKOS_CLIENT_ID ??= 'client_smoke';
process.env.WORKOS_API_KEY ??= 'sk_smoke';

const { alerts } = await import('./index');

/**
 * CU-868kh8jxf criterio 2 (tenant-scoped). Lo que estos tests fijan es que las rutas
 * están detrás de `tenantDerive` — la única fuente de `company_id`. Un `alert_events.id`
 * llega desde un link de email, es decir, desde fuera: si alguna de estas rutas
 * quedara colgada del router sin el guard, cualquiera con un uuid podría leer la
 * alerta de otra empresa, y sería un fallo silencioso (200 con datos ajenos) en vez de
 * un error visible.
 *
 * La verificación de que el WHERE por company_id realmente aísla necesita un Postgres
 * de verdad y vive en CU-868kh8zbj (infra de test de integración) — aquí no se finge
 * esa cobertura.
 */
describe('modules/alerts — tenant guard', () => {
  test('GET /alerts/:id sin bearer token responde 401, no 404 ni datos', async () => {
    const res = await alerts.handle(
      new Request('http://localhost/alerts/00000000-0000-0000-0000-000000000001'),
    );
    expect(res.status).toBe(401);
  });

  test('GET /alerts sin bearer token responde 401', async () => {
    const res = await alerts.handle(new Request('http://localhost/alerts'));
    expect(res.status).toBe(401);
  });

  test('un bearer token inválido no pasa el guard', async () => {
    const res = await alerts.handle(
      new Request('http://localhost/alerts/00000000-0000-0000-0000-000000000001', {
        headers: { authorization: 'Bearer not-a-real-jwt' },
      }),
    );
    expect(res.status).not.toBe(200);
  });
});
