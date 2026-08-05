import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Las particiones se aprovisionan ANTES del INSERT en `companies`, en las dos vías por
 * las que nace una empresa. Invertir ese orden cuelga la petición PARA SIEMPRE:
 * `CREATE TABLE ... PARTITION OF transactions` hereda la FK compuesta a `companies` y
 * validarla exige un ShareRowExclusiveLock, que choca con el RowExclusiveLock del INSERT
 * de la transacción del request — transacción que no cierra hasta `onAfterHandle`, o sea
 * hasta después del handler que está esperando ese mismo DDL.
 *
 * `tests/integration/partition-provisioning-deadlock.test.ts` demuestra el mecanismo
 * contra un Postgres real. Este fija el ORDEN EN EL CÓDIGO, que es lo que aquel no puede
 * cubrir: el bug original venía de un comentario razonable ("las particiones al final,
 * para no dejar huérfanas si algo falla antes"), así que es un cambio que alguien puede
 * rehacer de buena fe. Aquí falla en el acto y con el motivo escrito.
 */
const VIAS: Array<[archivo: string, ruta: string]> = [
  ['admin/companies.ts', 'POST /admin/companies — alta manual desde el backoffice'],
  ['billing/register.ts', 'POST /register — registro autoservicio'],
];

describe('orden de aprovisionamiento de una empresa', () => {
  test.each(VIAS)('%s aprovisiona particiones antes del INSERT (%s)', (archivo) => {
    const src = readFileSync(join(import.meta.dir, archivo as string), 'utf8');
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

    const provisiona = code.indexOf('provisionTenantPartitions(');
    const inserta = code.search(/\.insert\(\s*companies\s*\)/);

    expect(provisiona).toBeGreaterThan(-1);
    expect(inserta).toBeGreaterThan(-1);
    expect(provisiona).toBeLessThan(inserta);
  });

  test.each(VIAS)('%s pasa un id generado, no el que devuelve el INSERT', (archivo) => {
    const src = readFileSync(join(import.meta.dir, archivo as string), 'utf8');
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    // Aprovisionar con `company!.id` solo es posible DESPUÉS del INSERT: es la firma de
    // que el orden volvió a invertirse aunque las llamadas parezcan estar en su sitio.
    expect(code).not.toMatch(/provisionTenantPartitions\(\s*company!?\.?!?\.id\s*\)/);
    expect(code).toMatch(/const companyId = randomUUID\(\)/);
  });
});
