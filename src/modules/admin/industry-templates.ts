import { Elysia, t } from 'elysia';
import { desc, eq } from 'drizzle-orm';
import { adminGuard } from '@/guards/admin.guard';
import { assertStaffCapability } from '@/guards/require-capability';
import { industryTemplates, industryTemplateVersions } from '@/db/schema';
import { logAdminAction } from '@/lib/admin-audit';

/**
 * CU-868kfvafg: CRUD + historial de versiones de plantillas de mapeo por industria
 * (solo super_admin, manage_plans_and_templates). Las plantillas Excel descargables
 * (industry-templates/index.ts, endpoint del cliente) ya leen esta MISMA versión
 * actual — quedan alineadas automáticamente, sin trabajo extra (criterio 2).
 * Sin preview/test tool en MVP (criterio 3, deferido).
 */
export const adminIndustryTemplates = new Elysia({ prefix: '/admin/industry-templates' })
  .use(adminGuard)
  .get('/', async ({ tier, set, db }) => {
    assertStaffCapability(tier, 'manage_plans_and_templates', set);
    return db.select().from(industryTemplates);
  })
  .get('/:id/versions', async ({ tier, params, set, db }) => {
    assertStaffCapability(tier, 'manage_plans_and_templates', set);
    return db
      .select()
      .from(industryTemplateVersions)
      .where(eq(industryTemplateVersions.templateId, params.id))
      .orderBy(desc(industryTemplateVersions.version));
  })
  .post(
    '/',
    async ({ staffId, tier, body, set, db }) => {
      assertStaffCapability(tier, 'manage_plans_and_templates', set);
      const [template] = await db
        .insert(industryTemplates)
        .values({ industry: body.industry, name: body.name })
        .returning();
      const [version] = await db
        .insert(industryTemplateVersions)
        .values({
          templateId: template!.id,
          version: 1,
          synonyms: body.synonyms,
          fewShot: body.fewShot,
          createdBy: staffId,
        })
        .returning();
      await db
        .update(industryTemplates)
        .set({ currentVersionId: version!.id })
        .where(eq(industryTemplates.id, template!.id));

      await logAdminAction(db, {
        actorStaffId: staffId,
        action: 'industry_template.create',
        targetTable: 'industry_templates',
        targetId: template!.id,
        metadata: { industry: body.industry },
      });

      set.status = 201;
      return { id: template!.id, versionId: version!.id };
    },
    {
      body: t.Object({
        industry: t.String(),
        name: t.String(),
        synonyms: t.Record(t.String(), t.Array(t.String())),
        fewShot: t.Array(
          t.Object({ input: t.String(), output: t.Record(t.String(), t.Unknown()) }),
        ),
      }),
    },
  )
  .post(
    '/:id/versions',
    async ({ staffId, tier, params, body, set, db }) => {
      // Nueva versión = nueva fila (industry_template_versions es append-only, data
      // model.md §16) — nunca se actualiza una versión existente.
      assertStaffCapability(tier, 'manage_plans_and_templates', set);
      const [lastVersion] = await db
        .select({ version: industryTemplateVersions.version })
        .from(industryTemplateVersions)
        .where(eq(industryTemplateVersions.templateId, params.id))
        .orderBy(desc(industryTemplateVersions.version))
        .limit(1);

      const [version] = await db
        .insert(industryTemplateVersions)
        .values({
          templateId: params.id,
          version: (lastVersion?.version ?? 0) + 1,
          synonyms: body.synonyms,
          fewShot: body.fewShot,
          createdBy: staffId,
        })
        .returning();
      await db
        .update(industryTemplates)
        .set({ currentVersionId: version!.id })
        .where(eq(industryTemplates.id, params.id));

      await logAdminAction(db, {
        actorStaffId: staffId,
        action: 'industry_template.new_version',
        targetTable: 'industry_template_versions',
        targetId: version!.id,
        metadata: { templateId: params.id, version: version!.version },
      });

      set.status = 201;
      return { versionId: version!.id, version: version!.version };
    },
    {
      body: t.Object({
        synonyms: t.Record(t.String(), t.Array(t.String())),
        fewShot: t.Array(
          t.Object({ input: t.String(), output: t.Record(t.String(), t.Unknown()) }),
        ),
      }),
    },
  );
