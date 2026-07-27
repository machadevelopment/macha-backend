import { db } from '@/db/client';
import { adminAuditLog } from '@/db/schema';

/**
 * CU-868kfvagj: append-only (REVOKE UPDATE/DELETE, see migrations/0002_partitions_rls.sql).
 * Called explicitly at the end of every /admin/* mutation — no generic interceptor,
 * because a mutation's `targetTable`/`targetId`/`metadata` (before/after values) are
 * specific to what actually changed, which a generic hook can't know without
 * inspecting the handler's own logic anyway.
 */
export async function logAdminAction(params: {
  actorStaffId: string;
  companyId?: string;
  action: string;
  targetTable?: string;
  targetId?: string;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  await db.insert(adminAuditLog).values({
    actorStaffId: params.actorStaffId,
    companyId: params.companyId,
    action: params.action,
    targetTable: params.targetTable,
    targetId: params.targetId,
    metadata: params.metadata,
  });
}
