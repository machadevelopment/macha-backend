import { describe, expect, test } from 'bun:test';

process.env.DATABASE_URL ??= 'postgres://smoke:smoke@localhost:5432/smoke';

const { RETRY_POLICY, QUEUES } = await import('./index');

/**
 * El vencimiento de job por cola, que es un fallo SILENCIOSO cuando falta.
 *
 * QUÉ PASÓ (producción, 2026-08-06, documento `ce2a824b`). Ninguna cola declaraba
 * `expireInSeconds` y el default de pg-boss son 15 minutos —
 * `expire_in interval not null default interval '15 minutes'` en su `src/plans.js`,
 * confirmado además leyendo la fila del job: `expire_s = 900`. Un Excel real de PYME
 * pasó de ahí sin dificultad: una hoja de 85 filas por lote tardaba entre 140 y 220
 * segundos por llamada a Claude, y el libro llevaba 45 lotes en 14 minutos.
 *
 * Y falla de la peor manera. Vencer es una MARCA en la tabla de pg-boss, no una
 * cancelación: el worker sigue corriendo, deja de ser el dueño del job, y pg-boss encola
 * una segunda ejecución del mismo documento. Nada lanza una excepción, así que el `catch`
 * del worker —el único camino que marca `documents.status = 'failed'`— nunca corre. El
 * cliente ve "procesando" para siempre.
 *
 * POR QUÉ ESTE TEST Y NO OTRO. No prueba que 3600 sea el número correcto: eso es un juicio
 * calibrado con mediciones y vive comentado en el código. Prueba lo único que puede
 * romperse en silencio — que las colas de trabajo largo NO caigan en el default. Un
 * `expireInSeconds` ausente no da error de tipos ni de arranque; solo aparece semanas
 * después como un documento que nunca termina.
 */
describe('vencimiento de job por cola', () => {
  /** El default de pg-boss v10, en segundos. Si una cola larga declara esto o menos, da igual que lo declare. */
  const DEFAULT_PGBOSS = 900;

  /**
   * Colas cuyo trabajo puede pasar de 15 minutos. La ingesta llama a Claude una vez por
   * LOTE (varios minutos cada una en hojas anchas); el reporte llama una vez pero con
   * narrativa larga más render; el respaldo hace `pg_dump` de una base que crece.
   */
  const TRABAJO_LARGO = [QUEUES.excelIngest, QUEUES.reportGenerate, QUEUES.dbBackup] as const;

  for (const queue of TRABAJO_LARGO) {
    test(`${queue} declara un vencimiento explícito`, () => {
      expect(RETRY_POLICY[queue].expireInSeconds).toBeDefined();
    });
  }

  test('la ingesta de Excel supera el default: es la que lo rompió', () => {
    // Estrictamente mayor. Declarar 900 sería escribir el default a mano y no arreglar
    // nada, pero se vería como una decisión tomada.
    expect(RETRY_POLICY[QUEUES.excelIngest].expireInSeconds!).toBeGreaterThan(DEFAULT_PGBOSS);
  });

  test('toda cola conserva su política de reintentos', () => {
    // El vencimiento y los reintentos son ejes distintos: sin `retryLimit`, un job que
    // vence se reencola sin techo. Se comprueban juntos porque juntos acotan el peor caso.
    for (const queue of Object.values(QUEUES)) {
      expect(RETRY_POLICY[queue].retryLimit).toBeGreaterThanOrEqual(1);
    }
  });
});
