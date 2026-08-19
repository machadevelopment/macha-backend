import { Elysia, t } from 'elysia';
import { randomUUID } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import { reportStatus } from '@/lib/report-status';
import { tenantDerive } from '@/guards/tenant.derive';
import { assertClientCapability } from '@/guards/require-capability';
import {
  checkQueueGate,
  enforceTokenBucket,
  rateLimitedResponse,
  reportRateLimited,
} from '@/lib/rate-limit';
import { rateLimitConfig } from '@/config/rate-limit';
import { companies, reports, reportVersions } from '@/db/schema';
import { presignGet, uploadObject, reportRenderKey, reportPdfKey, reportXlsxKey } from '@/lib/s3';
import { estimateRequiredCredits, getActiveCreditRule, getCreditBalance } from '@/lib/credits';
import { enqueue, QUEUES } from '@/queue';
import {
  fromStoredMetrics,
  normalizeSections,
  DEFAULT_SECTIONS,
  REPORT_SECTIONS,
  REPORT_TYPES,
  type ReportType,
} from '@/lib/report-sections';
import { MAX_INSTRUCTIONS_LENGTH } from '@/lib/report-prompt';
import {
  DEFAULT_REPORT_FREQUENCY,
  REPORT_FREQUENCIES,
  reportFrequencySchema,
} from '@/lib/report-schedule';
import { renderReportPdf, renderReportXlsx, SECTION_LABELS } from '@/lib/report-render';
import { localeDeContenido } from '@/lib/content-locale';

/** Mismo formato de fecha que valida `/metrics/period`. */
const RANGO_ISO = t.String({
  pattern: '^\\d{4}-\\d{2}-\\d{2}$',
  error: 'Formato esperado: YYYY-MM-DD',
});

/**
 * Techo del rango de un reporte a demanda.
 *
 * No es una cifra redonda por gusto: la sección `revenue_trend` devuelve una SERIE DIARIA
 * (modules/metrics/period.ts) y esa serie viaja entera al prompt de Claude y a
 * `report_versions.metrics`. Con dos años el snapshot se vuelve el grueso de los tokens
 * de entrada de una llamada que se cobra en créditos, y el JSON del ledger crece sin que
 * nadie lea esos puntos. Un año cubre "todo el ejercicio", que es el rango largo que un
 * dueño de PYME pide de verdad.
 */
const MAX_RANGO_DIAS = 366;

/**
 * CU-868kfvacr (criterios 2/3) + CU-868kfvad1 (edición). `report_versions` es
 * append-only — "editar" un reporte crea una versión NUEVA con la narrativa
 * editada, reusando las mismas métricas (calculadas en SQL, no editables); nunca se
 * hace UPDATE sobre una versión existente.
 *
 * CU-B2-QA-20260811 agrega la generación a demanda y la exportación a PDF/Excel. Van en
 * ESTE módulo y no en uno nuevo montado en `src/app.ts` a propósito: la cadena de `.use()`
 * de la app ya está al borde del `TS2589: Type instantiation is excessively deep` que
 * obligó a agrupar módulos en el PR #129. Colgarlas del `Elysia` que ya existe no ensancha
 * esa cadena, y además comparten prefijo, guard y capacidades con lo que ya vive aquí.
 */
export const reports_ = new Elysia({ prefix: '/reports' })
  .use(tenantDerive)
  /**
   * Catálogo de lo que se puede pedir. Existe para que el frontend NO tenga que mantener
   * su propia copia de la lista de secciones: la única fuente de verdad de qué es
   * calculable de verdad es `lib/report-sections.ts`, y una lista duplicada en la UI es
   * exactamente cómo aparecería un selector con una sección que el backend no sabe llenar.
   */
  .get(
    '/catalog',
    async ({ companyId, role, set }) => {
      assertClientCapability(role, 'view_dashboard_reports', set);
      const limited = await enforceTokenBucket('read', companyId, set, 'GET /reports/catalog');
      if (limited) return limited;

      return {
        types: REPORT_TYPES.map((tipo) => ({
          type: tipo,
          defaultSections: DEFAULT_SECTIONS[tipo],
        })),
        sections: REPORT_SECTIONS.map((s) => ({
          section: s,
          labelEs: SECTION_LABELS[s].es,
          labelEn: SECTION_LABELS[s].en,
        })),
        maxRangeDays: MAX_RANGO_DIAS,
        maxInstructionsLength: MAX_INSTRUCTIONS_LENGTH,
      };
    },
    {
      response: {
        200: t.Object({
          types: t.Array(t.Object({ type: t.String(), defaultSections: t.Array(t.String()) })),
          sections: t.Array(
            t.Object({ section: t.String(), labelEs: t.String(), labelEn: t.String() }),
          ),
          maxRangeDays: t.Number(),
          maxInstructionsLength: t.Number(),
        }),
        429: rateLimitedResponse,
      },
    },
  )
  /**
   * Preferencia de reportes AUTOMÁTICOS de la empresa (CU-868kjc7t0, criterio 4 — lado
   * cliente; la pantalla que lo consume es Ajustes de empresa, CU-868kj3gm0).
   *
   * Vive en ESTE módulo y no en uno nuevo por la misma razón que la generación a demanda:
   * la cadena de `.use()` de `src/app.ts` ya está al borde del `TS2589` que obligó a
   * agrupar módulos en el PR #129, y esto comparte prefijo, guard y tenant-scoping con lo
   * que ya está aquí.
   *
   * `companyId` sale de `tenantDerive` (JWT verificado en el servidor), NUNCA del cuerpo:
   * si viniera del cliente, cualquiera podría apagarle los reportes a otra empresa.
   */
  .get(
    '/frequency',
    async ({ companyId, role, set, db }) => {
      // Leer la preferencia es parte de ver la configuración de reportes: misma capacidad
      // que ver los reportes. Cambiarla es otra cosa y va abajo.
      assertClientCapability(role, 'view_dashboard_reports', set);
      const limited = await enforceTokenBucket('read', companyId, set, 'GET /reports/frequency');
      if (limited) return limited;

      const [company] = await db
        .select({ reportFrequency: companies.reportFrequency })
        .from(companies)
        .where(eq(companies.id, companyId));

      return {
        frequency: company?.reportFrequency ?? DEFAULT_REPORT_FREQUENCY,
        options: [...REPORT_FREQUENCIES],
        defaultFrequency: DEFAULT_REPORT_FREQUENCY,
      };
    },
    {
      response: {
        200: t.Object({
          frequency: reportFrequencySchema,
          options: t.Array(t.String()),
          defaultFrequency: t.String(),
        }),
        429: rateLimitedResponse,
      },
    },
  )
  .put(
    '/frequency',
    async ({ companyId, role, body, set, db }) => {
      // `edit_send_reports` = owner/admin (lib/permissions.ts). El ticket pide "editable por
      // owner/admin" y ésa es exactamente la capacidad que ya expresa ese par sobre
      // reportes: no se inventa una capacidad nueva, que sería tocar una matriz aprobada.
      assertClientCapability(role, 'edit_send_reports', set);

      const [updated] = await db
        .update(companies)
        .set({ reportFrequency: body.frequency, updatedAt: new Date() })
        .where(eq(companies.id, companyId))
        .returning({ reportFrequency: companies.reportFrequency });

      if (!updated) {
        set.status = 404;
        return { error: 'Company not found' };
      }
      return { frequency: updated.reportFrequency };
    },
    {
      // TypeBox de Elysia (no zod): el CHECK de la migración 0023 es el respaldo, no la
      // primera línea.
      body: t.Object({ frequency: reportFrequencySchema }),
      response: {
        200: t.Object({ frequency: reportFrequencySchema }),
        404: t.Object({ error: t.String() }),
      },
    },
  )
  /**
   * Generación A DEMANDA.
   *
   * ASÍNCRONA, como la ingesta de Excel y por las mismas razones: adentro hay una llamada
   * a Claude con narrativa larga (la cola le da 15 minutos de vida, `RETRY_POLICY`), y una
   * petición HTTP sostenida durante ese rato se muere en cualquier proxy intermedio y deja
   * al usuario sin saber si su reporte existe. Además `report_generation` ya estaba
   * declarado en el gate de profundidad de cola (config/rate-limit.ts) desde
   * CU-868kfv97f y nadie lo usaba: esta es la ruta para la que se escribió.
   *
   * La fila de `reports` se crea AQUÍ y no en el worker para poder devolver su id: sin él,
   * el cliente no tendría a qué hacerle polling.
   */
  .post(
    '/generate',
    async ({ companyId, userId, role, body, set, db, headers }) => {
      // `edit_send_reports` (owner/admin) y no `view_dashboard_reports`: esto GASTA
      // créditos de la empresa. Ver es de todos; gastar el saldo con el que se paga el
      // resto de la IA no.
      assertClientCapability(role, 'edit_send_reports', set);

      if (body.from > body.to) {
        set.status = 400;
        return { error: 'El rango es inválido: la fecha inicial es posterior a la final.' };
      }
      const dias =
        Math.round(
          (Date.parse(`${body.to}T00:00:00Z`) - Date.parse(`${body.from}T00:00:00Z`)) / 86_400_000,
        ) + 1;
      if (dias > MAX_RANGO_DIAS) {
        set.status = 400;
        return { error: `El rango no puede exceder ${MAX_RANGO_DIAS} días (pediste ${dias}).` };
      }

      const reportType = (body.reportType ?? 'executive_summary') as ReportType;
      // Se normaliza contra el catálogo real: lo que no sea una sección calculable se cae
      // aquí y no llega ni al SQL ni al prompt. Vacío = el juego por defecto del tipo.
      const sections = body.sections
        ? normalizeSections(body.sections)
        : DEFAULT_SECTIONS[reportType];
      if (sections.length === 0) {
        set.status = 400;
        return { error: 'Ninguna de las secciones pedidas existe.' };
      }

      // Gate de profundidad de cola — mismo mecanismo que la carga de Excel: si la empresa
      // ya tiene reportes pesados en vuelo, se rechaza ANTES de crear la fila y encolar.
      const gate = await checkQueueGate(companyId, 'report_generation');
      if (!gate.allowed) {
        set.status = 429;
        reportRateLimited({
          mechanism: 'queue_gate',
          companyId,
          route: 'POST /reports/generate',
          detail: 'report_generation',
        });
        return {
          error: `Ya tienes ${gate.activeCount} reportes generándose; espera a que terminen (máximo ${rateLimitConfig.queueGate.maxJobs}).`,
          reason: 'queue_full' as const,
        };
      }

      // Bloqueo duro por créditos ANTES de encolar — copiado del intake de Excel
      // (CU-868kfvaa6): sin llamada, no hay fila de consumo. El VALOR sale del motor de
      // reglas versionado (`credit_rules`, editable en /admin/credit-rules), nunca de una
      // constante; sin regla activa la acción no cuesta.
      const creditRule = await getActiveCreditRule(db, 'report_generation');
      let required = 0;
      if (creditRule) {
        required = estimateRequiredCredits(creditRule, 1);
        const balance = await getCreditBalance(db, companyId);
        if (balance < required) {
          set.status = 402;
          return { error: 'insufficient_credits' as const, required, balance };
        }
      }

      const [report] = await db
        .insert(reports)
        .values({
          companyId,
          periodStart: body.from,
          periodEnd: body.to,
          // Migración 0022. No es 'daily' aunque el rango sea de un día: un reporte pedido
          // a mano no debe encadenarse como versión del automático de esa fecha.
          frequency: 'on_demand',
        })
        .returning();

      await enqueue(QUEUES.reportGenerate, {
        companyId,
        reportId: report!.id,
        periodStart: body.from,
        periodEnd: body.to,
        frequency: 'on_demand' as const,
        reportType,
        sections,
        instructions: body.instructions ?? null,
        // El débito se conecta SOLO en esta vía. El tick diario sigue sin cobrar: ver la
        // nota de `GenerateReportParams.debit` en lib/reports.ts.
        debit: true,
        // CU-868krvuct: el reporte se escribe en el idioma de QUIEN LO PIDIÓ. Se resuelve
        // acá y viaja en el payload porque el worker corre sin usuario — para él este job
        // es anónimo. El tick diario no manda nada y se queda con el de la empresa, que es
        // lo correcto: ese reporte no lo pidió nadie. Ver `lib/content-locale.ts`.
        locale: await localeDeContenido(db, companyId, userId, headers['x-content-locale']),
      });

      set.status = 202;
      return {
        reportId: report!.id,
        status: 'queued' as const,
        sections,
        creditsRequired: required,
      };
    },
    {
      body: t.Object({
        reportType: t.Optional(t.Union(REPORT_TYPES.map((r) => t.Literal(r)))),
        from: RANGO_ISO,
        to: RANGO_ISO,
        sections: t.Optional(
          t.Array(t.Union(REPORT_SECTIONS.map((s) => t.Literal(s))), {
            minItems: 1,
            maxItems: REPORT_SECTIONS.length,
          }),
        ),
        instructions: t.Optional(t.String({ maxLength: MAX_INSTRUCTIONS_LENGTH })),
      }),
      response: {
        202: t.Object({
          reportId: t.String(),
          status: t.Literal('queued'),
          sections: t.Array(t.String()),
          creditsRequired: t.Number(),
        }),
        400: t.Object({ error: t.String() }),
        402: t.Object({
          error: t.Literal('insufficient_credits'),
          required: t.Number(),
          balance: t.Number(),
        }),
        429: t.Object({ error: t.String(), reason: t.Literal('queue_full') }),
      },
    },
  )
  .get(
    '/',
    async ({ companyId, role, query, set, db }) => {
      assertClientCapability(role, 'view_dashboard_reports', set);

      // CU-868kh8qhp: bucket `read`.
      const limited = await enforceTokenBucket('read', companyId, set, 'GET /reports');
      if (limited) return limited;

      // CU-868kh913c: sin LIMIT esto devolvía TODOS los reportes de la empresa, y el
      // tick diario suma ~365 filas al año por empresa. Mismo patrón "load more"
      // (limit+1) que /admin/staging-rows.
      const limit = Math.min(Number(query.limit ?? 50) || 50, 200);
      const offset = Math.max(Number(query.offset ?? 0) || 0, 0);
      const rows = await db
        .select({
          id: reports.id,
          periodStart: reports.periodStart,
          periodEnd: reports.periodEnd,
          frequency: reports.frequency,
          currentVersionId: reports.currentVersionId,
          failedAt: reports.failedAt,
          updatedAt: reports.updatedAt,
        })
        .from(reports)
        .where(eq(reports.companyId, companyId))
        .orderBy(desc(reports.updatedAt))
        .limit(limit + 1)
        .offset(offset);
      /*
       * `ready` — CU-868krw2wn, criterio "un reporte que falla a medias NO se muestra como
       * completo".
       *
       * La fila de `reports` se crea ANTES de encolar el job (hay que devolverle un id al
       * usuario para que consulte el estado), así que una generación que falla deja la fila
       * sin versión. Hasta acá esa fila se devolvía idéntica a una buena: la lista la
       * pintaba como un reporte más, y al abrirla `GET /reports/:id` respondía 404 "Report
       * not found" — una mentira, porque el reporte existe; lo que no existe es su
       * contenido.
       *
       * Se deriva en el servidor en vez de exponer `currentVersionId` en crudo: es lo único
       * que el cliente necesita saber, y un booleano no invita a usar ese id para nada más
       * (fue exactamente el error de CU-868kh8uau, mandar un `reports.id` donde iba un
       * `report_versions.id`).
       */
      /*
       * TRES estados, no dos — CU-868ktkuq0.
       *
       * `ready` solo se preguntaba si había versión, y su ausencia significaba a la vez
       * "todavía se está generando" y "ya no se va a generar". La lista tenía que elegir
       * uno de los dos para pintar ese caso, elegía "falló", y como la fila de `reports`
       * se crea ANTES de encolar el job, TODO reporte recién pedido aparecía en rojo
       * diciendo que no se generó — durante todo el rato que la IA tardaba en escribirlo.
       *
       * El orden de lectura no admite contradicción: la versión manda (es la prueba de que
       * hay contenido), la marca de fallo solo se mira si no hay versión, y lo que no es ni
       * lo uno ni lo otro se está generando.
       *
       * `ready` SE CONSERVA junto a `status`: lo lee el frontend ya desplegado, y quitarlo
       * en el mismo despliegue que agrega `status` rompería la lista en la ventana en que
       * el backend va adelante del frontend.
       */
      const conEstado = rows.slice(0, limit).map(({ currentVersionId, failedAt, ...r }) => ({
        ...r,
        ready: currentVersionId !== null,
        status: reportStatus({ currentVersionId, failedAt }),
      }));
      return { reports: conEstado, hasMore: rows.length > limit };
    },
    { query: t.Object({ limit: t.Optional(t.String()), offset: t.Optional(t.String()) }) },
  )
  .get('/:id', async ({ companyId, role, params, set, db }) => {
    assertClientCapability(role, 'view_dashboard_reports', set);

    // CU-868kh8qhp: bucket `read`.
    const limited = await enforceTokenBucket('read', companyId, set, 'GET /reports/:id');
    if (limited) return limited;

    const [report] = await db
      .select()
      .from(reports)
      .where(and(eq(reports.id, params.id), eq(reports.companyId, companyId)));
    if (!report?.currentVersionId) {
      set.status = 404;
      return { error: 'Report not found' };
    }
    const [version] = await db
      .select()
      .from(reportVersions)
      .where(eq(reportVersions.id, report.currentVersionId));

    // CU-868kh8rz8 criterio 2: la moneda base sale de la empresa. Antes el detalle de
    // reporte la asumía 'GTQ' hardcodeada en el cliente, así que una empresa con
    // baseCurrency='USD' veía sus montos etiquetados como quetzales. `metrics` no trae
    // moneda propia (son amount_base ya convertidos), por eso viaja aparte aquí.
    const [company] = await db
      .select({ baseCurrency: companies.baseCurrency })
      .from(companies)
      .where(eq(companies.id, companyId));

    return {
      id: report.id,
      periodStart: report.periodStart,
      periodEnd: report.periodEnd,
      frequency: report.frequency,
      baseCurrency: company?.baseCurrency ?? 'GTQ',
      // CU-868kh8uau: el id de la VERSIÓN actual, expuesto explícitamente. El
      // deep-link a chat mandaba `reports.id` en el campo `reportVersionId` y, como
      // `chats.report_version_id` no tiene FK, se persistía una referencia falsa en
      // silencio. El cliente no puede derivar este id de ningún otro campo — si no se
      // devuelve, no hay forma de mandar el correcto.
      versionId: report.currentVersionId,
      version: version?.version,
      metrics: version?.metrics,
      narrative: version?.narrative,
      createdAt: version?.createdAt,
    };
  })
  .get('/:id/view', async ({ companyId, role, params, set, db }) => {
    assertClientCapability(role, 'view_dashboard_reports', set);

    // CU-868kh8qhp: bucket `read`. Cada llamada firma una URL de S3, así que aquí el
    // límite además acota cuántas presigned URLs se pueden emitir por minuto.
    const limited = await enforceTokenBucket('read', companyId, set, 'GET /reports/:id/view');
    if (limited) return limited;

    const [report] = await db
      .select({ currentVersionId: reports.currentVersionId })
      .from(reports)
      .where(and(eq(reports.id, params.id), eq(reports.companyId, companyId)));
    if (!report?.currentVersionId) {
      set.status = 404;
      return { error: 'Report not found' };
    }
    const [version] = await db
      .select({ s3RenderKey: reportVersions.s3RenderKey })
      .from(reportVersions)
      .where(eq(reportVersions.id, report.currentVersionId));
    if (!version?.s3RenderKey) {
      set.status = 404;
      return { error: 'Render not available' };
    }
    // Short-lived presigned URL (criterio 1) — the client fetches this and the
    // browser navigates to S3 directly; we never proxy the HTML bytes ourselves.
    const url = await presignGet(version.s3RenderKey, 120);
    return { url };
  })
  /**
   * Exportación a PDF o a Excel de la versión vigente de un reporte.
   *
   * SE RENDERIZA EN CADA LLAMADA y se sobrescribe el mismo objeto de S3, en vez de
   * preguntar primero si ya existe. Es deliberado: la clave es determinista (función pura
   * de company_id + version_id, ver lib/s3.ts) y el render no llama a Claude ni consulta
   * el ledger — sale entero de `report_versions.metrics` + `narrative`, que son inmutables.
   * Así que regenerar cuesta CPU y una subida, mientras que un `HEAD` a S3 costaría una
   * ida y vuelta igual y dejaría un camino donde una versión vieja del renderizador queda
   * congelada para siempre en el bucket.
   *
   * El binario NUNCA se devuelve por esta API: se sube a S3 y se responde con una URL
   * prefirmada de 120 segundos, después del chequeo de tenant y de capacidad (CLAUDE.md:
   * "S3 stores binaries; DB stores only keys ... access via short-lived presigned URLs
   * after tenant/role check").
   */
  .get(
    '/:id/export/:format',
    async ({ companyId, role, params, set, db }) => {
      assertClientCapability(role, 'view_dashboard_reports', set);

      // Bucket `read`: cada llamada firma una URL de S3, igual que `/view`.
      const limited = await enforceTokenBucket(
        'read',
        companyId,
        set,
        'GET /reports/:id/export/:format',
      );
      if (limited) return limited;

      const [report] = await db
        .select({ currentVersionId: reports.currentVersionId })
        .from(reports)
        .where(and(eq(reports.id, params.id), eq(reports.companyId, companyId)));
      if (!report?.currentVersionId) {
        set.status = 404;
        return { error: 'Report not found' };
      }

      // El `company_id` va también en esta consulta aunque el reporte ya esté scopeado:
      // es la tabla que se lee, y toda consulta a una tabla de negocio lleva su empresa
      // (regla no negociable). RLS es el respaldo, no la primera línea.
      const [version] = await db
        .select({
          metrics: reportVersions.metrics,
          narrative: reportVersions.narrative,
        })
        .from(reportVersions)
        .where(
          and(
            eq(reportVersions.id, report.currentVersionId),
            eq(reportVersions.companyId, companyId),
          ),
        );
      if (!version) {
        set.status = 404;
        return { error: 'Report not found' };
      }

      const [company] = await db
        .select({
          name: companies.name,
          baseCurrency: companies.baseCurrency,
          locale: companies.locale,
        })
        .from(companies)
        .where(eq(companies.id, companyId));

      const entrada = {
        companyName: company?.name ?? '',
        baseCurrency: company?.baseCurrency ?? 'GTQ',
        locale: company?.locale ?? ('es' as const),
        // Tolerante con las versiones anteriores a este ticket, que guardaron `metrics`
        // como un objeto plano de KPIs sin lista de secciones: se leen igual y exportan
        // su bloque de indicadores. Un reporte de hace un mes tiene que poder bajarse.
        data: fromStoredMetrics(version.metrics),
        narrative: version.narrative,
      };

      const esPdf = params.format === 'pdf';
      const key = esPdf
        ? reportPdfKey(companyId, report.currentVersionId)
        : reportXlsxKey(companyId, report.currentVersionId);
      const bytes = esPdf ? await renderReportPdf(entrada) : renderReportXlsx(entrada);
      const contentType = esPdf
        ? 'application/pdf'
        : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

      await uploadObject(key, bytes, contentType);
      const url = await presignGet(key, 120);
      return { url, format: params.format, expiresInSeconds: 120 };
    },
    {
      params: t.Object({
        id: t.String(),
        format: t.Union([t.Literal('pdf'), t.Literal('xlsx')]),
      }),
      response: {
        200: t.Object({
          url: t.String(),
          format: t.Union([t.Literal('pdf'), t.Literal('xlsx')]),
          expiresInSeconds: t.Number(),
        }),
        404: t.Object({ error: t.String() }),
        429: rateLimitedResponse,
      },
    },
  )
  .post(
    '/:id/versions',
    async ({ companyId, userId, role, params, body, set, db }) => {
      assertClientCapability(role, 'edit_send_reports', set);
      const [report] = await db
        .select()
        .from(reports)
        .where(and(eq(reports.id, params.id), eq(reports.companyId, companyId)));
      if (!report?.currentVersionId) {
        set.status = 404;
        return { error: 'Report not found' };
      }
      const [current] = await db
        .select()
        .from(reportVersions)
        .where(eq(reportVersions.id, report.currentVersionId));

      // CU-868kjc5pj: mismo patrón que lib/reports.ts — id generado aquí para poder
      // construir la clave de S3 y subir el render ANTES de insertar, y que la fila del
      // ledger nazca completa. El UPDATE que había aquí es `permission denied` con el
      // rol macha_app (REVOKE UPDATE,DELETE de la migración 0010) y además contradecía
      // el propio comentario de cabecera de este módulo sobre append-only.
      const versionId = randomUUID();
      const renderHtml = `<!doctype html><html><head><meta charset="utf-8"></head><body>${body.narrative.replace(/\n/g, '<br/>')}</body></html>`;
      const renderKey = reportRenderKey(companyId, versionId);
      await uploadObject(renderKey, Buffer.from(renderHtml, 'utf-8'), 'text/html');

      const [newVersion] = await db
        .insert(reportVersions)
        .values({
          id: versionId,
          companyId,
          reportId: report.id,
          version: current!.version + 1,
          metrics: current!.metrics,
          narrative: body.narrative,
          editedBy: userId,
          s3RenderKey: renderKey,
        })
        .returning();

      await db
        .update(reports)
        .set({ currentVersionId: newVersion!.id })
        .where(eq(reports.id, report.id));

      set.status = 201;
      return { id: report.id, version: newVersion!.version };
    },
    { body: t.Object({ narrative: t.String() }) },
  );
