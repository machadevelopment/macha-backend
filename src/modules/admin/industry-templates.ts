import { Elysia, t } from 'elysia';
import { and, desc, eq, gte, sql } from 'drizzle-orm';
import { adminGuard } from '@/guards/admin.guard';
import { assertStaffCapability } from '@/guards/require-capability';
import { adminAuditLog, companies, industryTemplates, industryTemplateVersions } from '@/db/schema';
import { logAdminAction } from '@/lib/admin-audit';
import { normalizeIndustry } from '@/lib/industry-template';
import { agruparCandidatos, type Correccion } from '@/lib/learning-loop';

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
  /**
   * Candidatos a ejemplo, minados de lo que el staff ya corrigió.
   *
   * ═══ CIERRA UN CICLO QUE ESTABA CORTADO ═══
   *
   * Cada corrección en la pantalla de revisión se guardaba en `admin_audit_log` y ahí se
   * moría: la plantilla nunca se enteraba, así que el modelo repetía el mismo error para
   * siempre y un humano lo arreglaba fila por fila, cada semana.
   *
   * El dato ya existía. Esto es la consulta que nadie había escrito.
   *
   * ═══ ES DE LECTURA, Y ESO ES EL DISEÑO ═══
   *
   * Devuelve candidatos ordenados por cuántas veces se repitió la misma corrección. NO publica
   * nada: el staff elige y usa el endpoint de versiones que ya existe. Un ciclo cerrado sin
   * humano se realimenta —el modelo aprendería de filas que él mismo clasificó y un sesgo se
   * amplificaría solo— y además `industry_template_versions` es append-only y versionada
   * justamente para que cada cambio tenga un autor.
   *
   * Se filtra por empresas de ESTA industria: la plantilla es de la industria, no de una
   * empresa, y un ejemplo idiosincrático de un cliente empeoraría la clasificación de todos
   * los demás.
   */
  .get(
    '/:id/candidatos',
    async ({ tier, params, query, set, db }) => {
      assertStaffCapability(tier, 'manage_plans_and_templates', set);

      const [plantilla] = await db
        .select()
        .from(industryTemplates)
        .where(eq(industryTemplates.id, params.id));
      if (!plantilla) {
        set.status = 404;
        return { error: 'Industry template not found' };
      }

      const desde = new Date(Date.now() - Number(query.dias ?? 90) * 86_400_000);

      const revisiones = await db
        .select({ metadata: adminAuditLog.metadata })
        .from(adminAuditLog)
        .innerJoin(companies, eq(companies.id, adminAuditLog.companyId))
        .where(
          and(
            eq(adminAuditLog.action, 'staging_row.review'),
            eq(sql`lower(btrim(${companies.industry}))`, normalizeIndustry(plantilla.industry)),
            gte(adminAuditLog.createdAt, desde),
          ),
        );

      /*
       * `targetEntity` no viaja en el metadata de la revisión (el handler guarda solo
       * before/after), y una revisión NO puede cambiarlo — el staff corrige la clasificación,
       * no a qué tabla va la fila. Se asume `transaction`, que es la forma de payload que trae
       * `type`/`category`; las de invoice/bill no tienen esos campos y `esCorreccionQueEnseña`
       * las descarta sola.
       */
      const correcciones: Correccion[] = revisiones.flatMap((r) => {
        const m = r.metadata as { before?: unknown; after?: unknown } | null;
        if (!m || typeof m.before !== 'object' || typeof m.after !== 'object') return [];
        if (m.before === null || m.after === null) return [];
        return [
          {
            before: m.before as Record<string, unknown>,
            after: m.after as Record<string, unknown>,
            targetEntity: 'transaction' as const,
          },
        ];
      });

      return {
        industria: plantilla.industry,
        revisionesLeidas: correcciones.length,
        candidatos: agruparCandidatos(correcciones),
      };
    },
    { query: t.Object({ dias: t.Optional(t.String()) }) },
  )
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
      // Normalizada al escribir, igual que la industria de la empresa: si el staff crea
      // la plantilla como "Tech" y el cliente se registró como "TECH", tienen que
      // encontrarse (lib/industry-template.ts).
      const industry = normalizeIndustry(body.industry);
      const [template] = await db
        .insert(industryTemplates)
        .values({ industry, name: body.name })
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
        metadata: { industry },
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
