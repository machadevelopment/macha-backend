import { Elysia } from 'elysia';
import { verifyToken } from '@/lib/auth';

/**
 * Enforcement point for tenant isolation. Verifies the WorkOS JWT, then resolves
 * (userId, companyId, role) server-side. company_id is NEVER taken from the client
 * or an AI model. Handlers assume derive has run and values are validated.
 *
 * TODO(F2): correlate workos_user_id -> users -> company_users for the active
 * company_id (org-switcher) and set the app.company_id GUC so Postgres RLS applies.
 * Reject companies with status='suspended' (US-21). Placeholder wiring below.
 */
export const tenantDerive = new Elysia({ name: 'tenant.derive' })
  .derive(async ({ headers, set }) => {
    const auth = headers['authorization'];
    if (!auth?.startsWith('Bearer ')) {
      set.status = 401;
      throw new Error('Missing bearer token');
    }
    const token = await verifyToken(auth.slice(7));
    // Placeholder: real resolution happens in F2 (see TODO above).
    return {
      userId: '' as string, // users.id
      companyId: '' as string, // resolved company_users.company_id
      role: 'member' as 'owner' | 'admin' | 'member',
      workosUserId: token.sub,
    };
  })
  .as('global');
