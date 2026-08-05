import { describe, expect, test } from 'bun:test';
import { evaluateIsolation, type RoleFacts } from './db-role-check';

/**
 * CU-868kjbw5h. Estos tests no tocan Postgres: prueban el JUICIO, que es la parte que
 * puede equivocarse en silencio. Las tres condiciones contra una base real ya las cubre
 * tests/integration/preconditions.test.ts.
 *
 * El caso que importa es el primero: es exactamente la configuración que corría en
 * staging y producción cuando se abrió el ticket, y la que hoy se obtiene por omisión.
 */

/** Un rol correctamente aislado: `macha_app` tal como lo describe 0010. */
const aislado: RoleFacts = {
  role: 'macha_app',
  ownedTables: [],
  isSuperuser: false,
  bypassesRls: false,
  appUrlIsExplicit: true,
};

describe('evaluateIsolation (CU-868kjbw5h)', () => {
  test('el fallback a DATABASE_URL no se considera aislado', () => {
    // La configuración por omisión: sin APP_DATABASE_URL, conectando como el dueño.
    const verdict = evaluateIsolation({
      ...aislado,
      role: 'postgres',
      ownedTables: ['transactions', 'invoices', 'ai_usage_events'],
      appUrlIsExplicit: false,
    });

    expect(verdict.isolated).toBe(false);
    // Los dos problemas son distintos y ambos deben aparecer: ser dueño rompe el
    // append-only, y el fallback explica POR QUÉ se llegó ahí.
    expect(verdict.reasons).toHaveLength(2);
    expect(verdict.reasons.join(' ')).toContain('DUEÑO');
    expect(verdict.reasons.join(' ')).toContain('APP_DATABASE_URL');
  });

  test('un rol no dueño, sin superuser ni BYPASSRLS, está aislado', () => {
    const verdict = evaluateIsolation(aislado);
    expect(verdict).toEqual({ isolated: true, role: 'macha_app', reasons: [] });
  });

  test('ser dueño de una sola tabla ya rompe el append-only', () => {
    // No hace falta poseer el esquema entero: basta una de las 6 tablas append-only
    // para que su REVOKE UPDATE,DELETE sea decorativo.
    const verdict = evaluateIsolation({ ...aislado, ownedTables: ['ai_usage_events'] });
    expect(verdict.isolated).toBe(false);
    expect(verdict.reasons).toHaveLength(1);
    expect(verdict.reasons[0]).toContain('ai_usage_events');
  });

  test('superuser y BYPASSRLS se reportan por separado', () => {
    const verdict = evaluateIsolation({ ...aislado, isSuperuser: true, bypassesRls: true });
    expect(verdict.isolated).toBe(false);
    expect(verdict.reasons).toHaveLength(2);
    expect(verdict.reasons[0]).toContain('SUPERUSER');
    expect(verdict.reasons[1]).toContain('BYPASSRLS');
  });

  test('APP_DATABASE_URL seteada a un rol que igual es dueño sigue sin estar aislada', () => {
    // El modo de fallo que el ticket NO menciona pero que el runbook puede provocar:
    // setear APP_DATABASE_URL apuntando por error al mismo rol dueño. Tener la variable
    // puesta no es la garantía; no poseer las tablas sí lo es.
    const verdict = evaluateIsolation({
      ...aislado,
      role: 'postgres',
      ownedTables: ['transactions'],
      appUrlIsExplicit: true,
    });
    expect(verdict.isolated).toBe(false);
    expect(verdict.reasons).toHaveLength(1);
  });
});
