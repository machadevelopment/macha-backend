import { Elysia } from 'elysia';
import { and, eq } from 'drizzle-orm';
import { verifyToken } from '@/lib/auth';
import { db as rootDb } from '@/db/client';
import { users, companyUsers, companies } from '@/db/schema';
import { reserveCompanyConnection } from '@/lib/db-scope';

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
 */
export const tenantDerive = new Elysia({ name: 'tenant.derive' })
  .derive(async ({ headers, request, set }) => {
    const auth = headers['authorization'];
    if (!auth?.startsWith('Bearer ')) {
      set.status = 401;
      throw new Error('Missing bearer token');
    }
    const token = await verifyToken(auth.slice(7));

    const [user] = await rootDb
      .select()
      .from(users)
      .where(eq(users.workosUserId, token.sub))
      .limit(1);
    if (!user) {
      set.status = 403;
      throw new Error('No Macha account for this identity');
    }

    const memberships = await rootDb
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

    // Scope this request's queries to the resolved company via SET LOCAL, inside a
    // transaction on a connection reserved just for this request (shared primitive
    // with the pg-boss workers — see lib/db-scope.ts). Cleared on commit/rollback
    // and released back to the pool by the hooks below.
    const { db: scopedDb, commit, rollback } = await reserveCompanyConnection(membership.companyId);
    pendingRelease.set(request, (ok: boolean) => (ok ? commit() : rollback()));

    return {
      userId: user.id as string,
      companyId: membership.companyId as string,
      role: membership.role,
      workosUserId: token.sub,
      db: scopedDb,
    };
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
  .as('global');
