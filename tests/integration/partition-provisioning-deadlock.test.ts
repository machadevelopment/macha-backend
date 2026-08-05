import { describe, expect, test, beforeAll, afterAll } from 'bun:test';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { ownerConnection, setupTestDatabase } from './setup';
import { provisionTenantPartitions } from '@/lib/tenant-provisioning';

/**
 * El alta de empresas se colgaba PARA SIEMPRE, por las dos vías que la crean
 * (`POST /admin/companies` y `POST /register`).
 *
 * El mecanismo: `provisionTenantPartitions` corre su DDL sobre OTRA conexión (rol
 * dueño), y `CREATE TABLE ... PARTITION OF transactions` hereda la FK compuesta a
 * `companies`; validarla exige un ShareRowExclusiveLock sobre `companies`. Si la
 * transacción del request ya hizo el INSERT en `companies`, tiene un RowExclusiveLock
 * que choca — y esa transacción no cierra hasta `onAfterHandle`, es decir hasta DESPUÉS
 * del handler que está esperando al DDL. El DDL espera al request; el request espera al
 * DDL.
 *
 * Postgres no lo mata: su detector de interbloqueos solo ve ciclos ENTRE LOCKS, y el
 * request no está esperando un lock sino al cliente (`idle in transaction`). En
 * producción quedó colgado indefinidamente, con `pg_blocking_pids` confirmando el ciclo.
 *
 * El arreglo es el orden: particiones primero, INSERT después.
 *
 * Estos tests OBSERVAN el bloqueo en `pg_blocking_pids` en vez de esperar a que expire
 * un temporizador. Es a propósito: la primera versión usaba `lock_timeout` y no
 * disparaba —postgres.js no fija una sesión por consulta, así que el `SET` acababa en
 * una conexión y el DDL en otra—, con lo que el test colgaba diez minutos en lugar de
 * fallar. Observar el estado real es determinista y además demuestra la otra mitad: que
 * al cerrar la transacción bloqueante, el DDL termina solo.
 */

const testUrl = () => String(process.env.DATABASE_URL);

/** Espera a que `pid` aparezca bloqueado por alguien; devuelve los bloqueadores. */
async function esperarBloqueo(
  probe: ReturnType<typeof postgres>,
  patron: string,
  intentos = 40,
): Promise<number[]> {
  for (let i = 0; i < intentos; i++) {
    const filas = await probe`
      select pid, pg_blocking_pids(pid) as blockers
      from pg_stat_activity
      where datname = current_database() and query like ${'%' + patron + '%'}
        and state = ${'active'} and cardinality(pg_blocking_pids(pid)) > 0
    `;
    if (filas.length > 0) return filas[0]!.blockers as number[];
    await Bun.sleep(250);
  }
  return [];
}

describe('aprovisionamiento de particiones vs. transacción del request', () => {
  let owner: ReturnType<typeof ownerConnection>;

  beforeAll(async () => {
    await setupTestDatabase();
    owner = ownerConnection();
  });

  afterAll(async () => {
    await owner?.end();
  });

  test('un INSERT sin confirmar en `companies` bloquea el DDL, y confirmarlo lo libera', async () => {
    const companyId = randomUUID();
    const sufijo = companyId.replace(/-/g, '_');

    const bloqueante = postgres(testUrl(), { max: 1, onnotice: () => {} });
    const ddl = postgres(testUrl(), { max: 1, onnotice: () => {} });
    const probe = postgres(testUrl(), { max: 1, onnotice: () => {} });

    try {
      // 1. La transacción del request: INSERT en `companies`, sin confirmar.
      await bloqueante`begin`;
      await bloqueante`
        insert into companies (id, workos_org_id, name, industry)
        values (${companyId}, ${'org_' + companyId.slice(0, 8)}, ${'Bloqueante ' + companyId}, 'retail')
      `;

      // 2. El DDL, sin esperarlo aquí: es justo lo que no puede avanzar.
      //
      //    El IIFE no es adorno. Las consultas de postgres.js son PEREZOSAS: el objeto
      //    que devuelve `unsafe()` es un thenable que no toca la red hasta que alguien
      //    lo espera. Guardarlo en una variable y seguir dejaba la consulta sin arrancar,
      //    así que no había nada bloqueado que observar y el test fallaba diciendo que
      //    el bug no existe. Envolverlo dispara la ejecución ya y deja una promesa real
      //    para el paso 4.
      const enCurso = (async () =>
        ddl.unsafe(
          `CREATE TABLE IF NOT EXISTS "transactions_${sufijo}" ` +
            `PARTITION OF transactions FOR VALUES IN ('${companyId}')`,
        ))();

      // 3. Lo que reproduce el bug: el DDL queda esperando un lock que retiene el request.
      const blockers = await esperarBloqueo(probe, `transactions_${sufijo}`);
      expect(blockers.length).toBeGreaterThan(0);

      // 4. Y la otra mitad: en cuanto la transacción cierra, el DDL termina solo. Eso
      //    prueba que el bloqueo era ESA transacción y no una lentitud cualquiera.
      await bloqueante`commit`;
      await enCurso;

      const [creada] = await owner`
        select tablename from pg_tables where tablename = ${'transactions_' + sufijo}
      `;
      expect(creada).toBeTruthy();
    } finally {
      await bloqueante`rollback`.catch(() => {});
      await Promise.all([bloqueante.end(), ddl.end(), probe.end()]);
    }
  }, 30_000);

  test('particiones ANTES del INSERT: no hay nada que bloquee y el alta completa', async () => {
    const companyId = randomUUID();

    // El orden nuevo: primero el DDL, con la transacción del request aún sin tocar
    // `companies`, así que no existe el RowExclusiveLock con el que chocaba.
    const particiones = await provisionTenantPartitions(companyId);
    expect(particiones).toHaveLength(3);

    const tx = postgres(testUrl(), { max: 1, onnotice: () => {} });
    try {
      await tx`begin`;
      await tx`
        insert into companies (id, workos_org_id, name, industry)
        values (${companyId}, ${'org_' + companyId.slice(0, 8)}, ${'Orden Correcto ' + companyId}, 'retail')
      `;
      await tx`commit`;
    } finally {
      await tx.end();
    }

    const [fila] = await owner`select name from companies where id = ${companyId}`;
    expect(fila?.name).toBe('Orden Correcto ' + companyId);

    const creadas = await owner`
      select tablename from pg_tables where tablename like ${'%' + companyId.replace(/-/g, '_')}
    `;
    expect(creadas).toHaveLength(3);
  }, 30_000);
});
