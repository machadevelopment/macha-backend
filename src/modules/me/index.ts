import { Elysia } from 'elysia';
import { and, eq } from 'drizzle-orm';
import { identityDerive } from '@/guards/identity.derive';
import { db } from '@/db/client';
import { companyUsers, companies, staff } from '@/db/schema';

/**
 * CU-868kfva6c: lista las membresías activas del usuario autenticado, sin requerir
 * un company_id todavía — es literalmente el endpoint que el org-switcher del
 * frontend usa para saber qué mostrar antes de que exista un contexto de empresa.
 * No hay tenant-scoping aquí a propósito: un usuario puede pertenecer a varias
 * empresas y este endpoint las lista TODAS (siempre limitado a las del propio
 * usuario, vía identityDerive -> company_users.user_id).
 */
export const me = new Elysia({ prefix: '/me' })
  .use(identityDerive)
  .get('/memberships', async ({ userId }) => {
    const memberships = await db
      .select({
        companyId: companyUsers.companyId,
        companyName: companies.name,
        role: companyUsers.role,
      })
      .from(companyUsers)
      .innerJoin(companies, eq(companies.id, companyUsers.companyId))
      .where(and(eq(companyUsers.userId, userId), eq(companyUsers.status, 'active')));

    const [staffRow] = await db
      .select({ tier: staff.tier })
      .from(staff)
      .where(and(eq(staff.userId, userId), eq(staff.status, 'active')))
      .limit(1);

    return { memberships, staffTier: staffRow?.tier ?? null };
  });
