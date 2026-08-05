import { describe, expect, test, beforeAll, afterAll } from 'bun:test';
import { drizzle } from 'drizzle-orm/postgres-js';
import { ownerConnection, setupTestDatabase } from './setup';
import * as schema from '@/db/schema';
import { getCreditBalance, grantInitialCredits, recordCreditAdjustment } from '@/lib/credits';
import { setPlatformSetting, SETTINGS_KEYS } from '@/lib/settings';
import type { DB } from '@/db/client';

/**
 * CU-868kjc7g5 / US-19: el ledger de créditos contra un Postgres real.
 *
 * Lo que no cabe en un test unitario y es exactamente lo que importa aquí: que el saldo
 * sea SUM(delta) sobre el ledger y no una columna que pueda desincronizarse, que una
 * corrección sea una fila compensatoria (y no un UPDATE, que la base ni siquiera
 * permite al rol de la app), y que una empresa nueva no nazca en 0.
 */

describe('créditos por empresa (CU-868kjc7g5)', () => {
  let owner: ReturnType<typeof ownerConnection>;
  let db: DB;
  let companyId: string;

  beforeAll(async () => {
    await setupTestDatabase();
    owner = ownerConnection();
    db = drizzle(owner, { schema }) as unknown as DB;

    const [c] = await owner`
      insert into companies (workos_org_id, name, industry)
      values ('org_credits', 'Créditos SA', 'retail') returning id
    `;
    companyId = c!.id;
  });

  afterAll(async () => {
    await owner?.end();
  });

  test('el saldo es la suma del ledger, no una columna materializada', async () => {
    expect(await getCreditBalance(db, companyId)).toBe(0);

    await recordCreditAdjustment(db, {
      companyId,
      delta: 500,
      reason: 'top_up',
      note: 'compensación por carga fallida',
    });
    expect(await getCreditBalance(db, companyId)).toBe(500);
  });

  test('corregir un abono equivocado es una fila compensatoria, no un UPDATE', async () => {
    await recordCreditAdjustment(db, {
      companyId,
      delta: -200,
      reason: 'top_up',
      note: 'revierte 200 de los 500 anteriores: monto equivocado',
    });

    expect(await getCreditBalance(db, companyId)).toBe(300);

    // Y el rastro sigue completo: el abono original NO desapareció. Eso es lo que
    // distingue un ledger append-only de una columna de saldo.
    const [row] = await owner`
      select count(*)::int as count from credit_transactions where company_id = ${companyId}
    `;
    expect(row!.count).toBe(2);
  });

  test('cada movimiento manual guarda su razón en el propio ledger', async () => {
    // US-19 pide "top-ups manuales con razón". Sin `note`, `reason='top_up'` solo dice
    // de qué TIPO es el movimiento — no por qué se hizo.
    const notas = await owner`
      select note from credit_transactions
      where company_id = ${companyId} order by created_at
    `;
    expect(notas.every((r: { note: string | null }) => (r.note ?? '').length > 0)).toBe(true);
  });

  test('una empresa nueva arranca con el saldo de platform_settings, no en 0', async () => {
    await setPlatformSetting(db, SETTINGS_KEYS.creditInitialGrant, 750);

    const [c] = await owner`
      insert into companies (workos_org_id, name, industry)
      values ('org_credits_nueva', 'Nueva SA', 'retail') returning id
    `;
    const nueva = c!.id;

    const { granted } = await grantInitialCredits(db, nueva);
    expect(granted).toBe(750);
    expect(await getCreditBalance(db, nueva)).toBe(750);
  });

  test('el valor sale de la configuración: cambiarlo NO exige desplegar', async () => {
    await setPlatformSetting(db, SETTINGS_KEYS.creditInitialGrant, 1234);

    const [c] = await owner`
      insert into companies (workos_org_id, name, industry)
      values ('org_credits_otra', 'Otra SA', 'retail') returning id
    `;
    const { granted } = await grantInitialCredits(db, c!.id);
    expect(granted).toBe(1234);
  });

  test('un valor de 0 o inválido no escribe una fila de ruido en el ledger', async () => {
    await setPlatformSetting(db, SETTINGS_KEYS.creditInitialGrant, 0);

    const [c] = await owner`
      insert into companies (workos_org_id, name, industry)
      values ('org_credits_cero', 'Cero SA', 'retail') returning id
    `;
    const { granted } = await grantInitialCredits(db, c!.id);
    expect(granted).toBe(0);

    const [row] = await owner`
      select count(*)::int as count from credit_transactions where company_id = ${c!.id}
    `;
    expect(row!.count).toBe(0);
  });
});
