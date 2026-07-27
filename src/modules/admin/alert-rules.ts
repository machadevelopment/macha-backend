import { Elysia, t } from 'elysia';
import { and, eq } from 'drizzle-orm';
import { adminGuard } from '@/guards/admin.guard';
import { assertStaffCapability } from '@/guards/require-capability';
import { db } from '@/db/client';
import { alertRules } from '@/db/schema';
import { logAdminAction } from '@/lib/admin-audit';

/** CU-868kfvafy criterio 2: umbrales de alerta por empresa (alert_rules ya es per-company, F0/F6). */
export const adminAlertRules = new Elysia({ prefix: '/admin/companies/:companyId/alert-rules' })
  .use(adminGuard)
  .get('/', async ({ tier, params, set }) => {
    assertStaffCapability(tier, 'view_companies', set);
    return db.select().from(alertRules).where(eq(alertRules.companyId, params.companyId));
  })
  .patch(
    '/:ruleKey',
    async ({ staffId, tier, params, body, set }) => {
      assertStaffCapability(tier, 'manage_companies', set);
      const [before] = await db
        .select()
        .from(alertRules)
        .where(
          and(eq(alertRules.companyId, params.companyId), eq(alertRules.ruleKey, params.ruleKey)),
        );
      if (!before) {
        set.status = 404;
        return { error: 'Alert rule not found' };
      }

      await db
        .update(alertRules)
        .set({
          threshold: body.threshold !== undefined ? String(body.threshold) : before.threshold,
          enabled: body.enabled ?? before.enabled,
        })
        .where(
          and(eq(alertRules.companyId, params.companyId), eq(alertRules.ruleKey, params.ruleKey)),
        );

      await logAdminAction({
        actorStaffId: staffId,
        companyId: params.companyId,
        action: 'alert_rule.update',
        targetTable: 'alert_rules',
        targetId: before.id,
        metadata: { before: { threshold: before.threshold, enabled: before.enabled }, after: body },
      });

      return { ruleKey: params.ruleKey, ...body };
    },
    { body: t.Object({ threshold: t.Optional(t.Number()), enabled: t.Optional(t.Boolean()) }) },
  );
