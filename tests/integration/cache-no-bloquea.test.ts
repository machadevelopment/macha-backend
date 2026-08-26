import { describe, expect, test, beforeAll, afterAll } from 'bun:test';
import postgres from 'postgres';
import { setupTestDatabase, ownerConnection, testOwnerUrl, testAppUrl } from './setup';

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * UN LECTOR NO PUEDE QUEDAR ESPERANDO A OTRO QUE DEJÓ SU CACHÉ SIN COMMITEAR
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *
 * Reproduce la caída del 2026-08-26 en su forma mínima: una transacción escribe el rollup de
 * una empresa y NO commitea; otra pide las métricas de esa misma empresa. Antes del arreglo la
 * segunda se encolaba detrás de la clave única `(empresa, mes, tipo)` — que es la misma para
 * todas las cargas de dashboard— hasta que la primera resolviera. Con la primera colgada, eso
 * era para siempre, y con `max: 10` bastaban nueve para dejar al producto sin base.
 *
 * Lo que se exige acá es que la segunda **devuelva su resultado sin esperar**. Que el caché
 * quede escrito o no es indiferente: el valor se calcula sobre el mismo ledger.
 */

process.env.DATABASE_URL = testOwnerUrl;
process.env.APP_DATABASE_URL = testAppUrl;

const { getOrComputeMonthlyAmounts } = await import('@/lib/rollups');
const { reserveScopedConnection } = await import('@/lib/db-scope');

const EMPRESA = '33333333-3333-4333-8333-333333333333';
const PERIODOS = ['2026-08-01'];

describe('la escritura del caché de rollups no bloquea lecturas', () => {
  let owner: ReturnType<typeof postgres>;

  beforeAll(async () => {
    await setupTestDatabase();
    owner = ownerConnection();
    await owner`insert into companies (id, workos_org_id, name, industry)
      values (${EMPRESA}::uuid, 'org_cache', 'Cache SA', 'retail')
      on conflict do nothing`;
    await owner`delete from metric_rollups where company_id = ${EMPRESA}::uuid`;
  });

  afterAll(async () => {
    if (owner) {
      await owner`delete from metric_rollups where company_id = ${EMPRESA}::uuid`.catch(() => {});
      await owner.end();
    }
  });

  test('el segundo lector responde sin esperar al primero que dejó la transacción abierta', async () => {
    // Lector A: calcula y escribe el caché, y NUNCA cierra. Es el pid 315 de producción.
    const a = await reserveScopedConnection(60_000);
    await a.scopeTo('app.company_id', EMPRESA);
    await getOrComputeMonthlyAmounts(a.db, EMPRESA, PERIODOS);

    // Lector B: la misma empresa y el mismo período, en otra conexión.
    const b = await reserveScopedConnection(60_000);
    await b.scopeTo('app.company_id', EMPRESA);

    const inicio = Date.now();
    const resultado = await Promise.race([
      getOrComputeMonthlyAmounts(b.db, EMPRESA, PERIODOS).then(() => 'respondió' as const),
      new Promise<'colgado'>((r) => setTimeout(() => r('colgado'), 5_000)),
    ]);
    const ms = Date.now() - inicio;

    await b.rollback();
    await a.rollback();

    expect(resultado).toBe('respondió');
    // Y rápido: si hubiera pasado por el lock de la clave única, habría esperado los 5 s.
    expect(ms).toBeLessThan(3_000);
  });

  /**
   * La otra mitad: sin competencia, el caché SÍ se escribe. Un arreglo que se saltara la
   * escritura siempre también pasaría el test de arriba, y dejaría al dashboard recalculando
   * desde cero en cada carga para siempre.
   */
  test('sin competencia, el caché se persiste', async () => {
    await owner`delete from metric_rollups where company_id = ${EMPRESA}::uuid`;

    const c = await reserveScopedConnection(60_000);
    await c.scopeTo('app.company_id', EMPRESA);
    await getOrComputeMonthlyAmounts(c.db, EMPRESA, PERIODOS);
    await c.commit();

    const [n] = await owner<{ n: string }[]>`
      select count(*)::text as n from metric_rollups where company_id = ${EMPRESA}::uuid`;
    expect(Number(n!.n)).toBeGreaterThan(0);
  });
});
