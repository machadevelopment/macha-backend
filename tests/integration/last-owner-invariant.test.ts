import { describe, expect, test, beforeAll, afterAll } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/postgres-js';
import { and, eq } from 'drizzle-orm';
import { ownerConnection, setupTestDatabase } from './setup';
import * as schema from '@/db/schema';
import { companyUsers } from '@/db/schema';
import type { DB } from '@/db/client';
import { contarOwnersActivos, dejariaSinOwner } from '@/lib/membership-invariants';

/**
 * CU-868kjc8pj criterio 4: los casos borde de "la empresa no se queda sin owner".
 *
 * Va a integración y no a unitario aunque el ticket lo pida así: la función usa
 * `SELECT ... FOR UPDATE`, que es justo la mitad que cierra la carrera y que un mock
 * daría por buena sin ejecutar nada. Probarla contra un Postgres real cuesta lo mismo y
 * cubre las dos mitades.
 */
describe('invariante del último owner (CU-868kjc8pj)', () => {
  let owner: ReturnType<typeof ownerConnection>;
  let db: DB;
  let companyId: string;
  let owner1: string;
  let owner2: string;
  let miembro: string;

  async function nuevoUsuario(): Promise<string> {
    const [u] = await owner`
      insert into users (workos_user_id, email, name)
      values (${'user_' + randomUUID()}, ${randomUUID() + '@test.local'}, 'Test') returning id`;
    return u!.id;
  }

  beforeAll(async () => {
    await setupTestDatabase();
    owner = ownerConnection();
    db = drizzle(owner, { schema }) as unknown as DB;

    const [c] = await owner`
      insert into companies (workos_org_id, name, industry)
      values (${'org_' + randomUUID()}, ${'Owners ' + randomUUID()}, 'retail') returning id`;
    companyId = c!.id;

    owner1 = await nuevoUsuario();
    owner2 = await nuevoUsuario();
    miembro = await nuevoUsuario();

    await db.insert(companyUsers).values([
      { companyId, userId: owner1, role: 'owner', status: 'active' },
      { companyId, userId: miembro, role: 'member', status: 'active' },
    ]);
  });

  afterAll(async () => {
    await owner?.end();
  });

  test('degradar al ÚNICO owner se detecta', async () => {
    expect(await contarOwnersActivos(db, companyId)).toBe(1);
    expect(
      await dejariaSinOwner(db, {
        companyId,
        userId: owner1,
        nextRole: 'member',
        nextStatus: 'active',
      }),
    ).toBe(true);
  });

  test('revocar al ÚNICO owner también — no solo el cambio de rol', async () => {
    expect(
      await dejariaSinOwner(db, {
        companyId,
        userId: owner1,
        nextRole: 'owner',
        nextStatus: 'revoked',
      }),
    ).toBe(true);
  });

  test('tocar a un member no owner no dispara nada', async () => {
    expect(
      await dejariaSinOwner(db, {
        companyId,
        userId: miembro,
        nextRole: 'member',
        nextStatus: 'revoked',
      }),
    ).toBe(false);
  });

  test('con DOS owners, degradar a uno es legítimo', async () => {
    await db
      .insert(companyUsers)
      .values({ companyId, userId: owner2, role: 'owner', status: 'active' });
    expect(await contarOwnersActivos(db, companyId)).toBe(2);

    expect(
      await dejariaSinOwner(db, {
        companyId,
        userId: owner1,
        nextRole: 'member',
        nextStatus: 'active',
      }),
    ).toBe(false);
  });

  test('degradar al segundo cuando ya solo queda él vuelve a bloquear', async () => {
    await db
      .update(companyUsers)
      .set({ role: 'member' })
      .where(and(eq(companyUsers.companyId, companyId), eq(companyUsers.userId, owner1)));
    expect(await contarOwnersActivos(db, companyId)).toBe(1);

    expect(
      await dejariaSinOwner(db, {
        companyId,
        userId: owner2,
        nextRole: 'member',
        nextStatus: 'active',
      }),
    ).toBe(true);
  });

  test('una empresa que YA está en cero owners no queda imposible de arreglar', async () => {
    const [c] = await owner`
      insert into companies (workos_org_id, name, industry)
      values (${'org_' + randomUUID()}, ${'Sin owner ' + randomUUID()}, 'retail') returning id`;
    const huerfana = c!.id;
    const u = await nuevoUsuario();
    await db
      .insert(companyUsers)
      .values({ companyId: huerfana, userId: u, role: 'member', status: 'active' });

    // Dato heredado: nadie es owner. La validación no debe impedir promover a alguien.
    expect(await contarOwnersActivos(db, huerfana)).toBe(0);
    expect(
      await dejariaSinOwner(db, {
        companyId: huerfana,
        userId: u,
        nextRole: 'owner',
        nextStatus: 'active',
      }),
    ).toBe(false);
  });
});
