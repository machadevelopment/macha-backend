import { Elysia, t } from 'elysia';
import { and, eq } from 'drizzle-orm';
import { adminGuard } from '@/guards/admin.guard';
import { assertStaffCapability } from '@/guards/require-capability';
import { db } from '@/db/client';
import { companies, companyUsers, users } from '@/db/schema';
import { logAdminAction } from '@/lib/admin-audit';
import { provisionTenantPartitions } from '@/lib/tenant-provisioning';

/**
 * CU-868kfvaex/868kfvagj/868kfvaf5: namespace admin — companies + gestión de
 * usuarios. Demuestra el guard (staff/super_admin, separado de tenantDerive) y el
 * patrón de auditoría (toda mutación llama a logAdminAction).
 */
export const adminCompanies = new Elysia({ prefix: '/admin/companies' })
  .use(adminGuard)
  .get('/', async ({ tier, set }) => {
    assertStaffCapability(tier, 'view_companies', set);
    return db
      .select({
        id: companies.id,
        name: companies.name,
        industry: companies.industry,
        baseCurrency: companies.baseCurrency,
        status: companies.status,
        createdAt: companies.createdAt,
      })
      .from(companies);
  })
  .post(
    '/',
    async ({ staffId, tier, body, set }) => {
      // CU-868kfvaf5 criterio 1: alta manual de empresas + aprovisiona partición.
      assertStaffCapability(tier, 'manage_companies', set);
      const [company] = await db
        .insert(companies)
        .values({
          workosOrgId: body.workosOrgId,
          name: body.name,
          industry: body.industry,
          baseCurrency: body.baseCurrency,
          locale: body.locale,
        })
        .returning();

      const partitions = await provisionTenantPartitions(company!.id);

      await logAdminAction({
        actorStaffId: staffId,
        companyId: company!.id,
        action: 'company.create',
        targetTable: 'companies',
        targetId: company!.id,
        metadata: { name: body.name, industry: body.industry, partitions },
      });

      set.status = 201;
      return { id: company!.id, name: company!.name, partitions };
    },
    {
      body: t.Object({
        workosOrgId: t.String(),
        name: t.String(),
        industry: t.String(),
        baseCurrency: t.Union([t.Literal('GTQ'), t.Literal('USD')]),
        locale: t.Union([t.Literal('es'), t.Literal('en')]),
      }),
    },
  )
  .patch(
    '/:id/status',
    async ({ staffId, tier, params, body, set }) => {
      assertStaffCapability(tier, 'manage_companies', set);
      const [before] = await db.select().from(companies).where(eq(companies.id, params.id));
      if (!before) {
        set.status = 404;
        return { error: 'Company not found' };
      }

      await db.update(companies).set({ status: body.status }).where(eq(companies.id, params.id));

      await logAdminAction({
        actorStaffId: staffId,
        companyId: params.id,
        action: 'company.status_change',
        targetTable: 'companies',
        targetId: params.id,
        metadata: { before: before.status, after: body.status },
      });

      return { id: params.id, status: body.status };
    },
    { body: t.Object({ status: t.Union([t.Literal('active'), t.Literal('suspended')]) }) },
  )
  .get('/:id/users', async ({ tier, params, set }) => {
    assertStaffCapability(tier, 'view_companies', set);
    return db
      .select({
        userId: companyUsers.userId,
        email: users.email,
        name: users.name,
        role: companyUsers.role,
        status: companyUsers.status,
        receivesReports: companyUsers.receivesReports,
      })
      .from(companyUsers)
      .innerJoin(users, eq(users.id, companyUsers.userId))
      .where(eq(companyUsers.companyId, params.id));
  })
  .patch(
    '/:id/users/:userId',
    async ({ staffId, tier, params, body, set }) => {
      // Gestión de miembros existentes (rol/estado). Invitar a un usuario que nunca
      // ha iniciado sesión vía WorkOS (sin fila en `users` todavía) necesitaría el
      // flujo de invite de WorkOS + email — no construido, mismo alcance que el
      // registro autoservicio de M8.
      assertStaffCapability(tier, 'manage_companies', set);
      const [before] = await db
        .select()
        .from(companyUsers)
        .where(and(eq(companyUsers.companyId, params.id), eq(companyUsers.userId, params.userId)));
      if (!before) {
        set.status = 404;
        return { error: 'Membership not found' };
      }

      await db
        .update(companyUsers)
        .set({ role: body.role ?? before.role, status: body.status ?? before.status })
        .where(and(eq(companyUsers.companyId, params.id), eq(companyUsers.userId, params.userId)));

      await logAdminAction({
        actorStaffId: staffId,
        companyId: params.id,
        action: 'company_user.update',
        targetTable: 'company_users',
        targetId: params.userId,
        metadata: { before, after: body },
      });

      return { userId: params.userId, ...body };
    },
    {
      body: t.Object({
        role: t.Optional(t.Union([t.Literal('owner'), t.Literal('admin'), t.Literal('member')])),
        status: t.Optional(t.Union([t.Literal('active'), t.Literal('invited'), t.Literal('revoked')])),
      }),
    },
  );
