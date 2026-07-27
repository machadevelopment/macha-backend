import { Elysia } from 'elysia';
import { and, eq } from 'drizzle-orm';
import { verifyToken } from '@/lib/auth';
import { db } from '@/db/client';
import { users, staff } from '@/db/schema';

/**
 * CU-868kfvaex: /admin/* is a SEPARATE namespace, structurally outside the
 * tenant-scoped chain (guards/tenant.derive.ts) — gated by the `staff` table, not
 * `company_users`. Uses the root `db` (no RLS/company_id scoping): staff legitimately
 * need cross-company visibility here — that's deliberate and audited (see
 * lib/admin-audit.ts), not a leak, per the ticket's non-negotiable rule.
 */
export const adminGuard = new Elysia({ name: 'admin.guard' })
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

    const [staffRow] = await db
      .select()
      .from(staff)
      .where(and(eq(staff.userId, user.id), eq(staff.status, 'active')))
      .limit(1);
    if (!staffRow) {
      set.status = 403;
      throw new Error('Not staff');
    }

    return { staffId: staffRow.id as string, tier: staffRow.tier };
  })
  .as('global');
