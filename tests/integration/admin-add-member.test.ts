import { describe, expect, test, beforeAll, afterAll } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/postgres-js';
import { and, eq } from 'drizzle-orm';
import { ownerConnection, setupTestDatabase } from './setup';
import * as schema from '@/db/schema';
import { companyUsers } from '@/db/schema';
import type { DB } from '@/db/client';

/**
 * CU-868kmqrg7: `POST /admin/companies/:id/users`.
 *
 * Faltaba la pieza que hacía inútil todo lo demás: se podía crear una empresa completa
 * —particiones, alertas, créditos— y nada podía meter a nadie dentro. El único endpoint
 * de miembros era un PATCH que devuelve 404 si la membresía no existe. En el alta de
 * producción del 2026-08-05 la fila hubo que insertarla a mano contra la base.
 *
 * Se prueba contra un Postgres real y no con mocks porque lo que puede fallar aquí es
 * justamente lo que un mock daría por bueno: el índice único de `company_users`, la FK
 * a `users` y la búsqueda por correo sin distinguir mayúsculas.
 */
describe('alta de miembro desde el panel admin (CU-868kmqrg7)', () => {
  let owner: ReturnType<typeof ownerConnection>;
  let db: DB;
  let companyId: string;
  let userId: string;
  const email = `Alta.Miembro.${Date.now()}@Machafinance.com`; // mayúsculas a propósito

  beforeAll(async () => {
    await setupTestDatabase();
    owner = ownerConnection();
    db = drizzle(owner, { schema }) as unknown as DB;

    const [c] = await owner`
      insert into companies (workos_org_id, name, industry)
      values (${'org_' + randomUUID()}, ${'Alta Miembro ' + randomUUID()}, 'retail') returning id`;
    companyId = c!.id;

    // El alta JIT guarda el correo en minúsculas (lib/user-provisioning.ts).
    const [u] = await owner`
      insert into users (workos_user_id, email, name)
      values (${'user_' + randomUUID()}, ${email.toLowerCase()}, 'Alta Miembro') returning id`;
    userId = u!.id;
  });

  afterAll(async () => {
    await owner?.end();
  });

  test('encuentra al usuario por correo sin distinguir mayúsculas y crea la membresía', async () => {
    // Se ejercita la consulta exacta del handler: `lower(email) = <minúsculas>`.
    const [encontrado] = await owner`
      select id from users where lower(email) = ${email.trim().toLowerCase()}`;
    expect(encontrado?.id).toBe(userId);

    await db.insert(companyUsers).values({ companyId, userId, role: 'owner', status: 'active' });

    const [m] = await db
      .select({ role: companyUsers.role, status: companyUsers.status })
      .from(companyUsers)
      .where(and(eq(companyUsers.companyId, companyId), eq(companyUsers.userId, userId)));
    expect(m).toEqual({ role: 'owner', status: 'active' });
  });

  /**
   * Los IIFE no son adorno: las consultas de Drizzle (como las de postgres.js) son
   * PEREZOSAS — el objeto que devuelve `.values()` no toca la red hasta que alguien lo
   * espera, y `expect(...).rejects` no lo dispara. Sin envolverlas, estos dos tests
   * pasaban en verde afirmando que la base no rechaza nada. Verificado: el índice único
   * y la FK sí existen (`company_users_company_user_uq`, `company_users_user_id_users_id_fk`).
   */
  test('la base rechaza duplicar la membresía — el 409 del handler no es cosmético', async () => {
    await expect(
      (async () => {
        await db
          .insert(companyUsers)
          .values({ companyId, userId, role: 'member', status: 'active' });
      })(),
    ).rejects.toThrow(/company_users_company_user_uq|duplicate key/i);
  });

  test('no se puede meter a un usuario que no existe: la FK lo impide', async () => {
    await expect(
      (async () => {
        await db.insert(companyUsers).values({
          companyId,
          userId: randomUUID(),
          role: 'member',
          status: 'active',
        });
      })(),
    ).rejects.toThrow(/foreign key|users_id_fk/i);
  });
});
