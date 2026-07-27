import { Elysia } from 'elysia';
import { eq } from 'drizzle-orm';
import { verifyToken } from '@/lib/auth';
import { db } from '@/db/client';
import { users } from '@/db/schema';

/**
 * Lighter guard than tenant.derive.ts (CU-868kfva6c): verifies the bearer JWT and
 * resolves the Macha user row, WITHOUT scoping to a company. This is intentionally
 * the guard used BEFORE a company_id exists — it's what lets the org-switcher list
 * every membership so the user (or the frontend, on a single-membership account) can
 * pick one. Routes needing tenant-scoped data still go through tenantDerive.
 */
export const identityDerive = new Elysia({ name: 'identity.derive' })
  .derive(async ({ headers, set }) => {
    const auth = headers['authorization'];
    if (!auth?.startsWith('Bearer ')) {
      set.status = 401;
      throw new Error('Missing bearer token');
    }
    const token = await verifyToken(auth.slice(7));

    const [user] = await db.select().from(users).where(eq(users.workosUserId, token.sub)).limit(1);
    if (!user) {
      set.status = 403;
      throw new Error('No Macha account for this identity');
    }

    return { userId: user.id as string, workosUserId: token.sub };
  })
  .as('global');
