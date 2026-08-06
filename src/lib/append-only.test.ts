import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * CU-868kjc5pj: ningún camino de código puede hacer UPDATE ni DELETE sobre los siete
 * ledgers append-only de CLAUDE.md.
 *
 * POR QUÉ ESTE TEST EXISTE Y NO BASTABA CON EL DE INTEGRACIÓN. `tests/integration/
 * append-only.test.ts` ya prueba que la base RECHAZA un UPDATE sobre cada ledger, y
 * estaba en verde mientras `lib/reports.ts` y `modules/reports/index.ts` hacían
 * exactamente ese UPDATE en producción. Aquel test prueba el privilegio en la base;
 * este prueba el código. Son cosas distintas y hacían falta las dos: el fallo real
 * (`permission denied for table report_versions`) solo aparecía ejecutando la
 * generación de un reporte contra Postgres con el rol macha_app, que ningún test hacía.
 *
 * Es un barrido de texto sobre el fuente, no análisis semántico: busca las llamadas
 * de Drizzle `.update(tabla)` / `.delete(tabla)` con el identificador de la tabla. Un
 * SQL crudo equivalente se le escaparía — a cambio no necesita compilar nada y falla
 * en el commit, no en producción.
 */

// Los nombres tal como se exportan en src/db/schema (camelCase de las 6 tablas de
// CLAUDE.md). La lista vive duplicada respecto de tests/integration/setup.ts a
// propósito: aquella son nombres de tabla SQL, estos son identificadores de TypeScript.
const APPEND_ONLY_ENTITIES = [
  'aiUsageEvents',
  'creditTransactions',
  'adminAuditLog',
  'reportVersions',
  'industryTemplateVersions',
  'payments',
  'inventoryMovements',
] as const;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    if (!full.endsWith('.ts') || full.endsWith('.test.ts')) return [];
    return [full];
  });
}

describe('los ledgers append-only no se mutan desde el código (CU-868kjc5pj)', () => {
  const files = sourceFiles(join(import.meta.dir, '..'));

  test('el barrido encuentra fuentes que revisar', () => {
    // Si un refactor mueve los módulos, este test evita que el resto pase en verde
    // simplemente por no estar mirando nada.
    expect(files.length).toBeGreaterThan(30);
  });

  for (const entity of APPEND_ONLY_ENTITIES) {
    test(`ninguna llamada .update(${entity}) ni .delete(${entity})`, () => {
      const offenders = files.filter((file) => {
        const src = readFileSync(file, 'utf8');
        return new RegExp(`\\.(update|delete)\\(\\s*${entity}\\s*\\)`).test(src);
      });
      expect(offenders).toEqual([]);
    });
  }
});
