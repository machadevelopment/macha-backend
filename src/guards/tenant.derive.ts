import { Elysia } from 'elysia';
import { and, eq } from 'drizzle-orm';
import { verifyBearerOr401 } from '@/guards/bearer';
import { db as rootDb } from '@/db/client';
import { users, companyUsers, companies, subscriptions } from '@/db/schema';
import { reserveScopedConnection } from '@/lib/db-scope';

// Reserved connections are kept off the typed context (handlers never see the raw
// pooled connection) and released via onAfterHandle/onError, keyed by the request.
const pendingRelease = new WeakMap<Request, (commit: boolean) => Promise<void>>();

/**
 * Enforcement point for tenant isolation. Verifies the WorkOS JWT, correlates
 * workos_user_id -> users -> company_users for the active company, rejects
 * suspended companies, and sets the app.company_id GUC (SET LOCAL, inside a
 * transaction scoped to this request) so Postgres RLS applies as a backstop.
 * company_id is NEVER taken from the client directly — the X-Company-Id header
 * only selects among the caller's own verified memberships.
 *
 * CU-868kj3utc — POR QUÉ EL ORDEN DE ABAJO ES EL QUE ES. El scoping se monta en dos
 * tiempos sobre UNA SOLA conexión reservada, porque el guard descubre los dos datos en
 * momentos distintos:
 *
 *   1. `users` no tiene RLS: `workos_user_id → users.id` se resuelve con el pool normal.
 *   2. Se reserva la conexión del request y se setea `app.user_id`. Sin ese GUC, la
 *      política de `company_users` (migración 0012) no devuelve NINGUNA fila al rol
 *      `macha_app` — la tabla donde se descubre la empresa no se puede filtrar por una
 *      empresa que todavía no se conoce.
 *   3. Resuelta la membresía, se setea `app.company_id` en la MISMA transacción, y a
 *      partir de ahí todo (incluida la lectura de `subscriptions`, que sí tiene RLS por
 *      empresa) corre con el backstop completo.
 *
 * Antes de este ticket los pasos 2 y 3 se hacían con `rootDb` sin GUC alguno, lo que
 * funcionaba solo porque `APP_DATABASE_URL` cae al rol dueño cuando no está seteada.
 * Apuntarla a `macha_app` —el paso de despliegue documentado en 0010— devolvía 403 en
 * todo request autenticado.
 */
export const tenantDerive = new Elysia({ name: 'tenant.derive' })
  .derive(async ({ headers, request, set }) => {
    // CU-868kmvaf7: un token vencido devolvía 500 con el texto de `jose`. Ver bearer.ts.
    const token = await verifyBearerOr401(headers['authorization'], set);

    const [user] = await rootDb
      .select()
      .from(users)
      .where(eq(users.workosUserId, token.sub))
      .limit(1);
    if (!user) {
      set.status = 403;
      throw new Error('No Macha account for this identity');
    }

    // Conexión reservada para este request, con transacción abierta. A partir de aquí
    // cualquier salida por error DEBE liberarla — de ahí el try/catch: no se delega en
    // `onError`, que solo cubre lo que Elysia ya considera un request en curso.
    const scoped = await reserveScopedConnection();
    try {
      // Paso 2 (ver cabecera): sin este GUC, `company_users` no devuelve nada al rol
      // macha_app. Es identidad ya verificada — sale del `sub` del JWT, no del cliente.
      await scoped.scopeTo('app.user_id', user.id);

      const memberships = await scoped.db
        .select({
          companyId: companyUsers.companyId,
          role: companyUsers.role,
          companyStatus: companies.status,
        })
        .from(companyUsers)
        .innerJoin(companies, eq(companies.id, companyUsers.companyId))
        .where(and(eq(companyUsers.userId, user.id), eq(companyUsers.status, 'active')));

      if (memberships.length === 0) {
        set.status = 403;
        throw new Error('No active company membership');
      }

      const requestedCompanyId = headers['x-company-id'];
      let membership: (typeof memberships)[number] | undefined;
      if (requestedCompanyId) {
        membership = memberships.find((m) => m.companyId === requestedCompanyId);
        if (!membership) {
          set.status = 403;
          throw new Error('Not a member of the requested company');
        }
      } else if (memberships.length === 1) {
        membership = memberships[0];
      } else {
        set.status = 400;
        throw new Error('Multiple company memberships; X-Company-Id header is required');
      }
      if (!membership) {
        set.status = 403;
        throw new Error('Unable to resolve active company');
      }

      if (membership.companyStatus === 'suspended') {
        set.status = 403;
        throw new Error('Company is suspended');
      }

      // Paso 3: resuelta la empresa, el resto del request corre con el backstop de RLS
      // completo. `subscriptions` tiene RLS por empresa (migración 0009), así que la
      // lectura de abajo depende de que este SET LOCAL ya haya ocurrido.
      await scoped.scopeTo('app.company_id', membership.companyId);

      // CU-868kfvaem criterio 2: efecto de la suscripción sobre el acceso, aplicado
      // aquí (no solo en el frontend). Solo 'cancelled' bloquea — 'past_due' se deja
      // pasar (gracia de cobro, Recurrente ya reintenta el cargo por su cuenta) y
      // 'pending_checkout'/sin fila de subscription (empresas creadas antes de M8,
      // o mientras el registro autoservicio todavía no completa el primer checkout)
      // tampoco bloquean — bloquear ahí rompería el flujo de registro mismo.
      const [subscription] = await scoped.db
        .select({ status: subscriptions.status })
        .from(subscriptions)
        .where(eq(subscriptions.companyId, membership.companyId))
        .limit(1);
      if (subscription?.status === 'cancelled') {
        set.status = 402;
        throw new Error('Subscription is cancelled');
      }

      // Cleared on commit/rollback and released back to the pool by the hooks below.
      pendingRelease.set(request, (ok: boolean) => (ok ? scoped.commit() : scoped.rollback()));

      return {
        userId: user.id as string,
        companyId: membership.companyId as string,
        role: membership.role,
        workosUserId: token.sub,
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
  // `scoped`, NO `global`. Ver la nota compartida en src/app.test.ts: `global` propaga
  // este `derive` al padre y a TODO lo que se monte después en src/app.ts, así que la
  // autenticación de inquilino se filtraba a rutas que están fuera de esta cadena a
  // propósito — los webhooks de Recurrente (que traen firma svix, no bearer) y
  // /register (que existe para crear la membresía que este guard exige) respondían 401.
  // `scoped` llega a la instancia que hace .use() y corta ahí, que es el alcance real.
  .as('scoped');
