import { Elysia } from 'elysia';
import { and, eq } from 'drizzle-orm';
import { verifyBearerOr401 } from '@/guards/bearer';
import { db as rootDb } from '@/db/client';
import { users, staff } from '@/db/schema';
import { reserveScopedConnection } from '@/lib/db-scope';

// Reserved connections are kept off the typed context (handlers never see the raw
// pooled connection) and released via onAfterHandle/onError, keyed by the request.
const pendingRelease = new WeakMap<Request, (commit: boolean) => Promise<void>>();

/**
 * CU-868kfvaex: /admin/* is a SEPARATE namespace, structurally outside the
 * tenant-scoped chain (guards/tenant.derive.ts) — gated by the `staff` table, not
 * `company_users`. Staff legitimately need cross-company visibility here — that's
 * deliberate and audited (see lib/admin-audit.ts), not a leak.
 *
 * CU-868kjc4af — CÓMO SE CONSIGUE ESA VISIBILIDAD AHORA. Antes bastaba con usar el pool
 * global sin GUC, porque el rol dueño se saltaba RLS. Desde la migración 0010 (`FORCE
 * ROW LEVEL SECURITY`) eso dejó de ser cierto y, con `macha_app`, cada endpoint admin
 * devolvía cero filas — sin error, con un 200 y una lista vacía.
 *
 * La vía es un GUC de escape, `app.cross_tenant = 'on'`, que se setea AQUÍ y solo aquí,
 * después de verificar que el usuario está en `staff` con estado activo. La política de
 * la migración 0013 lo admite como alternativa a `app.company_id`.
 *
 * LA GARANTÍA ES ESTE ORDEN, y conviene no romperlo al tocar el archivo: primero se
 * verifica la identidad, después la fila en `staff`, y solo entonces se abre el escape.
 * Un 401 o un 403 salen ANTES de que exista la conexión con el GUC puesto. Y ninguna
 * otra parte del código lo setea: `tests/integration/admin-cross-tenant.test.ts` recorre
 * el fuente para que siga siendo verdad.
 */
export const adminGuard = new Elysia({ name: 'admin.guard' })
  .derive(async ({ headers, request, set }) => {
    // CU-868kmvaf7: un token vencido devolvía 500 con el texto de `jose`. Ver bearer.ts.
    const token = await verifyBearerOr401(headers['authorization'], set);

    // `users` y `staff` no tienen RLS, así que el gate se resuelve con el pool normal —
    // y, más importante, se resuelve ANTES de abrir ninguna vía cross-tenant.
    const [user] = await rootDb
      .select()
      .from(users)
      .where(eq(users.workosUserId, token.sub))
      .limit(1);
    if (!user) {
      set.status = 403;
      throw new Error('No Macha account for this identity');
    }

    const [staffRow] = await rootDb
      .select()
      .from(staff)
      .where(and(eq(staff.userId, user.id), eq(staff.status, 'active')))
      .limit(1);
    if (!staffRow) {
      set.status = 403;
      throw new Error('Not staff');
    }

    const scoped = await reserveScopedConnection();
    try {
      await scoped.scopeTo('app.cross_tenant', 'on');
      pendingRelease.set(request, (ok: boolean) => (ok ? scoped.commit() : scoped.rollback()));

      return {
        staffId: staffRow.id as string,
        tier: staffRow.tier,
        userId: user.id as string,
        db: scoped.db,
      };
    } catch (err) {
      await scoped.rollback();
      throw err;
    }
  })
  .onAfterHandle(async ({ request }) => {
    const release = pendingRelease.get(request);
    if (release) {
      pendingRelease.delete(request);
      await release(true);
    }
  })
  .onError(async ({ request }) => {
    const release = pendingRelease.get(request);
    if (release) {
      pendingRelease.delete(request);
      await release(false);
    }
  })
  // `scoped`, no `global` — misma razón que en tenant.derive.ts. Ver src/app.test.ts.
  // Aquí importa el doble: con `global`, este guard y el de inquilino se aplicaban AMBOS
  // a /admin/*, reservando dos conexiones por request y rechazando con 403 al staff que
  // no tuviera además una membresía de empresa.
  .as('scoped');
