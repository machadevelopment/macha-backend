import { Elysia, t } from 'elysia';
import { eq } from 'drizzle-orm';
import { adminGuard } from '@/guards/admin.guard';
import { assertStaffCapability } from '@/guards/require-capability';
import { db } from '@/db/client';
import { companies } from '@/db/schema';
import { logAdminAction } from '@/lib/admin-audit';

/**
 * CU-868kfvaex/868kfvagj: primer endpoint real del namespace admin — demuestra el
 * guard (staff/super_admin, separado de tenantDerive) y el patrón de auditoría
 * (toda mutación llama a logAdminAction). Gestión completa de empresas/usuarios
 * (alta, industria, etc.) es CU-868kfvaf5, junto al resto del panel admin.
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
  );
