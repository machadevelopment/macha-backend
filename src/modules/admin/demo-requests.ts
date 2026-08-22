import { Elysia, t } from 'elysia';
import { desc } from 'drizzle-orm';
import { adminGuard } from '@/guards/admin.guard';
import { assertStaffCapability } from '@/guards/require-capability';
import { demoRequests } from '@/db/schema';

/**
 * Listado de solicitudes de demo de la landing.
 *
 * Solo lectura: la tabla es append-only y no hay estado "contactado" (ver migración `0036`).
 * Capacidad `view_companies`: es la misma puerta que usa el resto del catálogo de plataforma
 * que no es dinero ni plantillas — cualquier staff del día a día tiene que poder ver quién
 * escribió, no solo el super_admin.
 *
 * NO se devuelve `ipHash`: no sirve para contactar y es el único rastro del origen. El panel
 * no lo necesita.
 */
export const adminDemoRequests = new Elysia({ prefix: '/admin/demo-requests' }).use(adminGuard).get(
  '/',
  async ({ tier, query, set, db }) => {
    assertStaffCapability(tier, 'view_companies', set);
    const limit = Math.min(Number(query.limit ?? 50) || 50, 200);
    const offset = Math.max(Number(query.offset ?? 0) || 0, 0);

    const rows = await db
      .select({
        id: demoRequests.id,
        name: demoRequests.name,
        companyName: demoRequests.companyName,
        email: demoRequests.email,
        phone: demoRequests.phone,
        message: demoRequests.message,
        locale: demoRequests.locale,
        source: demoRequests.source,
        createdAt: demoRequests.createdAt,
      })
      .from(demoRequests)
      .orderBy(desc(demoRequests.createdAt))
      .limit(limit + 1)
      .offset(offset);

    return {
      requests: rows.slice(0, limit),
      hasMore: rows.length > limit,
    };
  },
  {
    query: t.Object({
      limit: t.Optional(t.String()),
      offset: t.Optional(t.String()),
    }),
  },
);
