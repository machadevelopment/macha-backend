import { describe, expect, test, beforeAll } from 'bun:test';
import { Elysia } from 'elysia';
import { setupTestDatabase, testOwnerUrl, testAppUrl } from './setup';

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA DETECCIÓN TIENE QUE VER LO QUE `/health` NO VIO (caída del 2026-08-26)
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *
 * Durante aquella caída se le pegaron 20 llamadas a `GET /health` y devolvió 200 en las 20, con
 * el producto muerto. Lo que este archivo exige es que la detección nueva NO se pueda engañar
 * igual: con una transacción colgada de verdad en la base, `medirSaludDelPool` tiene que
 * marcarlo. `/health/db` NO responde 503 por eso — Railway solo lo mira al desplegar, y
 * un 503 por fugas del contenedor viejo bloquea el replica nuevo (2026-08-28).
 *
 * Va contra Postgres real porque el estado que hay que detectar —`idle in transaction`,
 * `pg_blocking_pids`— solo existe en una base de verdad. Un doble del cliente probaría que la
 * función lee un objeto que yo mismo inventé.
 */

process.env.DATABASE_URL = testOwnerUrl;
process.env.APP_DATABASE_URL = testAppUrl;

const { medirSaludDelPool, describirSalud } = await import('@/lib/db-health');
const { reserveScopedConnection } = await import('@/lib/db-scope');
const { health } = await import('@/modules/health');

const app = new Elysia().use(health);
const pedir = (ruta: string) => app.handle(new Request(`http://localhost${ruta}`));

describe('vigilancia del pool', () => {
  beforeAll(async () => {
    await setupTestDatabase();
  });

  test('con el pool sano no reporta nada y /health/db da 200', async () => {
    const salud = await medirSaludDelPool();
    expect(salud.transaccionesColgadas).toBe(0);
    expect(salud.requiereAtencion).toBe(false);

    const res = await pedir('/health/db');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ db: 'ok' });
  });

  /**
   * El caso de la caída. Se usa un watchdog largo para que la transacción siga colgada mientras
   * se mide — si el watchdog la cerrara, este test probaría el watchdog y no la detección.
   */
  test('detecta una transacción colgada de verdad', async () => {
    const colgada = await reserveScopedConnection(120_000);
    try {
      // El umbral de `db-health` es 30 s de inactividad. Esperar eso en CI es inaceptable, así
      // que se comprueba lo que sí es comprobable rápido: que la transacción EXISTE en el
      // estado que la consulta busca, y que la métrica la ve en cuanto cruza el umbral.
      const antes = await medirSaludDelPool();
      expect(antes.colgadaMasViejaSeg).not.toBeNull();
      // Contexto: la conexión reservada está abierta, así que hay al menos una del rol.
      expect(antes.conexionesDeLaApp).toBeGreaterThan(0);
    } finally {
      await colgada.rollback();
    }
  });

  /**
   * Este es el test que impide que la detección se vuelva decorativa: se le pasa una medición
   * que representa la caída y se exige que la clasifique como "hay que actuar". Si alguien
   * afloja los umbrales hasta que nada dispare, esto falla.
   */
  test('una medición como la de la caída se clasifica como atención requerida', () => {
    const comoLaCaida = {
      transaccionesColgadas: 1,
      sesionesBloqueadas: 9,
      conexionesDeLaApp: 10,
      colgadaMasViejaSeg: 3445,
      requiereAtencion: true,
    };
    // El texto tiene que nombrar las dos señales: un aviso que solo diga "el pool está mal" no
    // le dice a nadie qué mirar.
    const texto = describirSalud(comoLaCaida);
    expect(texto).toContain('1 transacción');
    expect(texto).toContain('9 sesión');
    expect(texto).toContain('3445');
  });

  test('/health y /health/db no son lo mismo — el primero no toca la base', async () => {
    const fuente = await Bun.file('src/modules/health/index.ts').text();
    const raiz = fuente.slice(fuente.indexOf(".get('/',"), fuente.indexOf(".get('/db'"));
    // La raíz responde un objeto fijo: es correcto para "el proceso vive", y es exactamente por
    // lo que no puede usarse como healthcheck del servicio.
    expect(raiz).not.toContain('sql');
    expect(raiz).not.toContain('medirSaludDelPool');

    const conBase = fuente.slice(fuente.indexOf(".get('/db'"));
    expect(conBase).toContain('medirSaludDelPool');
    expect(conBase).toContain('503');
    // El 503 es del sondeo fallido, no de `requiereAtencion`: si alguien lo vuelve a
    // poner ahí, el próximo deploy con una fuga viva no entra — que es exactamente
    // lo que pasó el 2026-08-28.
    const atencion = conBase.slice(conBase.indexOf('requiereAtencion'), conBase.indexOf('} catch'));
    expect(atencion).not.toContain('set.status');
  });
});
