import { Elysia, t } from 'elysia';
import { and, desc, eq, gte, sql } from 'drizzle-orm';
import { adminGuard } from '@/guards/admin.guard';
import { assertStaffCapability } from '@/guards/require-capability';
import {
  adminAuditLog,
  companies,
  industryStarterTemplates,
  industryTemplates,
  industryTemplateVersions,
} from '@/db/schema';
import { logAdminAction } from '@/lib/admin-audit';
import { normalizeIndustry } from '@/lib/industry-template';
import { agruparCandidatos, type Correccion } from '@/lib/learning-loop';
import { industryStarterKey, uploadObject } from '@/lib/s3';

/**
 * CU-868kfvafg: CRUD + historial de versiones de plantillas de mapeo por industria
 * (solo super_admin, manage_plans_and_templates). Las plantillas Excel descargables
 * (industry-templates/index.ts, endpoint del cliente) ya leen esta MISMA versión
 * actual — quedan alineadas automáticamente, sin trabajo extra (criterio 2).
 * Sin preview/test tool en MVP (criterio 3, deferido).
 */
/**
 * Tipos aceptados para una plantilla descargable. Es el MISMO conjunto que acepta la ingesta
 * del cliente, y a propósito: el archivo que se le entrega tiene que poder volver por la
 * misma puerta por la que entra todo lo demás.
 */
const EXT_PLANTILLA: Record<string, string> = {
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.ms-excel': 'xls',
  'text/csv': 'csv',
};

export const adminIndustryTemplates = new Elysia({ prefix: '/admin/industry-templates' })
  .use(adminGuard)
  /**
   * ═══════════════════════════════════════════════════════════════════════════════════════════
   * PLANTILLA .XLSX DESCARGABLE POR INDUSTRIA — subida por staff (Jose, 2026-08-20)
   * ═══════════════════════════════════════════════════════════════════════════════════════════
   *
   * Jose: "el equipo debe poder cargar diferentes plantillas por tipo de industria, para que los
   * usuarios que no tengan un Excel establecido puedan descargarla al hacer el onboarding".
   *
   * ═══ LA DESCARGA YA EXISTÍA; ESTO ES LA OTRA MITAD ═══
   *
   * `/industry-templates/download` genera un .xlsx al vuelo con las categorías canónicas de la
   * industria de la empresa. Sirve para enseñar QUÉ COLUMNAS llenar y por eso nunca da un enlace
   * roto. Lo que no puede hacer es traer contenido CURADO: hojas de verdad, ejemplos con sentido
   * para una cafetería o una consultora, un formato pensado por alguien. Eso no se genera.
   *
   * Después de esto, esa ruta prefiere el archivo curado si existe y sigue generando si no. O
   * sea que el criterio "si una industria no tiene plantilla, el onboarding no rompe ni muestra
   * un enlace roto" se cumple POR CONSTRUCCIÓN, sin un condicional en el frontend: es la misma
   * URL y el mismo botón, siempre.
   *
   * ═══ SE GUARDA UNA VERSIÓN NUEVA, NUNCA SE REEMPLAZA ═══
   *
   * `version = max + 1` y el objeto de S3 lleva la versión en su clave. Sin eso, subir una
   * corrección sobreescribiría los bytes de la versión anterior y la fila vieja quedaría
   * apuntando a un archivo que ya no es el suyo — un historial que miente es peor que no tener
   * historial.
   *
   * El `INSERT` va DESPUÉS de que S3 confirme. Al revés quedaría una fila apuntando a un objeto
   * que no existe, y la descarga del cliente fallaría con un 500 en vez de caer al generado.
   * En este orden, un fallo de S3 no deja rastro y el operador reintenta.
   */
  .post(
    '/starters/:industry',
    async ({ staffId, tier, params, body, set, db }) => {
      assertStaffCapability(tier, 'manage_plans_and_templates', set);

      // La misma normalización que usa el resolver de la ingesta: sin esto "Retail" y "retail"
      // serían dos industrias con dos plantillas, y la empresa recibiría la que le toque por
      // cómo alguien escribió su rubro.
      const industry = normalizeIndustry(params.industry);
      if (!industry) {
        set.status = 422;
        return { error: 'La industria no puede estar vacía' };
      }

      const file = body.file;
      const ext = EXT_PLANTILLA[file.type];
      if (!ext) {
        set.status = 415;
        return { error: `Tipo no soportado: ${file.type}. Debe ser .xlsx, .xls o .csv` };
      }

      const [ultima] = await db
        .select({ version: industryStarterTemplates.version })
        .from(industryStarterTemplates)
        .where(eq(industryStarterTemplates.industry, industry))
        .orderBy(desc(industryStarterTemplates.version))
        .limit(1);
      const version = (ultima?.version ?? 0) + 1;

      const key = industryStarterKey(industry, version, ext);
      await uploadObject(key, new Uint8Array(await file.arrayBuffer()), file.type);

      const [fila] = await db
        .insert(industryStarterTemplates)
        .values({
          industry,
          s3Key: key,
          originalFilename: file.name,
          fileSizeBytes: file.size,
          contentType: file.type,
          notes: body.notes ?? null,
          version,
          createdBy: staffId,
        })
        .returning({ id: industryStarterTemplates.id });

      await logAdminAction(db, {
        actorStaffId: staffId,
        // Es catálogo de PLATAFORMA: no pertenece a ninguna empresa. Se OMITE en vez de
        // mandar una: poner un `company_id` acá haría parecer, en la auditoría, que se tocó la
        // configuración de ese cliente.
        action: 'industry_starter_template.upload',
        targetTable: 'industry_starter_templates',
        targetId: fila!.id,
        metadata: { industry, version, filename: file.name, sizeBytes: file.size },
      });

      return { id: fila!.id, industry, version, filename: file.name };
    },
    {
      body: t.Object({
        // Tope externo holgado para que una subida absurda no llegue al handler. Una plantilla
        // curada es un archivo chico: son ejemplos, no la contabilidad de nadie.
        file: t.File({ maxSize: '10m' }),
        notes: t.Optional(t.String({ maxLength: 500 })),
      }),
    },
  )

  /**
   * El historial de plantillas descargables. La vigente es la de `version` más alta.
   *
   * Se devuelven TODAS y no solo la vigente: el panel necesita mostrar el historial para que
   * volver atrás sea posible —subir de nuevo un archivo anterior— y para que una lista de
   * versiones con su nota sea revisable dentro de seis meses.
   */
  .get('/starters', async ({ tier, set, db }) => {
    assertStaffCapability(tier, 'manage_plans_and_templates', set);
    return db
      .select({
        id: industryStarterTemplates.id,
        industry: industryStarterTemplates.industry,
        originalFilename: industryStarterTemplates.originalFilename,
        fileSizeBytes: industryStarterTemplates.fileSizeBytes,
        notes: industryStarterTemplates.notes,
        version: industryStarterTemplates.version,
        createdAt: industryStarterTemplates.createdAt,
      })
      .from(industryStarterTemplates)
      .orderBy(industryStarterTemplates.industry, desc(industryStarterTemplates.version));
  })
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
