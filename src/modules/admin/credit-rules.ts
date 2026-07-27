import { Elysia, t } from 'elysia';
import { and, desc, eq } from 'drizzle-orm';
import { adminGuard } from '@/guards/admin.guard';
import { assertStaffCapability } from '@/guards/require-capability';
import { db } from '@/db/client';
import { creditRules } from '@/db/schema';
import { logAdminAction } from '@/lib/admin-audit';

/**
 * CU-868kfvafy criterio 1 (no negociable): tabla acción↔créditos configurable desde
 * el panel. credit_rules es global (no por empresa) y versionado — una nueva regla
 * es una fila nueva (version+1), nunca un UPDATE sobre una activa; activarla implica
 * desactivar la anterior de la misma acción.
 */
export const adminCreditRules = new Elysia({ prefix: '/admin/credit-rules' })
  .use(adminGuard)
  .get('/', async ({ tier, set }) => {
    assertStaffCapability(tier, 'edit_action_to_credits_ratio', set);
    return db.select().from(creditRules).orderBy(desc(creditRules.createdAt));
  })
  .post(
    '/',
    async ({ staffId, tier, body, set }) => {
      assertStaffCapability(tier, 'edit_action_to_credits_ratio', set);
      const [lastVersion] = await db
        .select({ version: creditRules.version })
        .from(creditRules)
        .where(eq(creditRules.actionKind, body.actionKind))
        .orderBy(desc(creditRules.version))
        .limit(1);

      // Deactivate the current active rule for this action — only one active version
      // per action_kind at a time (getActiveCreditRule picks the highest active one).
      await db
        .update(creditRules)
        .set({ active: false })
        .where(and(eq(creditRules.actionKind, body.actionKind), eq(creditRules.active, true)));

      const [rule] = await db
        .insert(creditRules)
        .values({
          actionKind: body.actionKind,
          ruleType: body.ruleType,
          creditsPerUnit: String(body.creditsPerUnit),
          unit: body.unit,
          version: (lastVersion?.version ?? 0) + 1,
          active: true,
          createdBy: staffId,
        })
        .returning();

      await logAdminAction({
        actorStaffId: staffId,
        action: 'credit_rule.create',
        targetTable: 'credit_rules',
        targetId: rule!.id,
        metadata: body,
      });

      set.status = 201;
      return rule;
    },
    {
      body: t.Object({
        actionKind: t.Union([
          t.Literal('excel'),
          t.Literal('chat'),
          t.Literal('insight'),
          t.Literal('report_generation'),
        ]),
        ruleType: t.Union([t.Literal('fixed'), t.Literal('variable')]),
        creditsPerUnit: t.Number(),
        unit: t.Optional(
          t.Union([
            t.Literal('execution'),
            t.Literal('batch'),
            t.Literal('sheet'),
            t.Literal('row'),
          ]),
        ),
      }),
    },
  );
