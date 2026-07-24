import { Elysia } from 'elysia';

/**
 * /admin/* is a SEPARATE namespace, structurally outside the tenant-scoped chain,
 * gated by the staff table (staff/super_admin). Every admin mutation writes
 * admin_audit_log. Placeholder — staff resolution lands in the admin feature ticket.
 */
export const adminGuard = new Elysia({ name: 'admin.guard' })
  .derive(async () => {
    // TODO: verify WorkOS session in the "Macha Internal" org, resolve staff tier.
    return { staffId: '' as string, tier: 'staff' as 'staff' | 'super_admin' };
  })
  .as('global');
