import { Elysia, t } from 'elysia';
import { and, asc, eq, getTableColumns } from 'drizzle-orm';
import { adminGuard } from '@/guards/admin.guard';
import { assertStaffCapability } from '@/guards/require-capability';
import { stagingRows, companies, documents } from '@/db/schema';
import { classifySheetRows } from '@/lib/anthropic';
import { resolveIndustryTemplate } from '@/lib/industry-template';
import { insertAiUsageEvent } from '@/lib/ai-usage';
import { logAdminAction } from '@/lib/admin-audit';
import { enqueue, QUEUES } from '@/queue';
import type { DB } from '@/db/client';

/**
 * CU-868kfvaf5 criterio 2: revisión de filas marcadas con edición directa +
 * re-extracción (kind=excel_correction, NUNCA debita créditos — CLAUDE.md).
 *
 * Nota sobre "re-extracción": staging_rows no guarda las celdas crudas originales
 * por fila (solo el payload ya mapeado + flag_reason) — el archivo original vive en
 * S3 a nivel de documento completo, sin manera de correlacionar de vuelta a una fila
 * específica. Re-extraer aquí significa re-correr la clasificación de Claude usando
 * el payload actual + flag_reason como entrada (pidiéndole que reconsidere), no
 * re-parsear el Excel desde cero — es lo que la forma real de los datos permite.
 */
/**
 * Cierra el ciclo de la revisión interna: encola la promoción de la fila que se acaba de
 * resolver.
 *
 * NO ESPERA A QUE NO QUEDE NINGUNA PENDIENTE, y esa es la diferencia con la primera versión
 * de esta función. Con promoción parcial (migración 0020) cada fila aprobada entra por su
 * cuenta, así que hacer esperar a la última pendiente retrasaría sin motivo a las 400 ya
 * resueltas de un archivo de 414 — y si una sola fila nunca se resuelve, no entrarían nunca.
 *
 * Los estados que sí reciben filas nuevas son `promoted` (el normal ahora: el archivo ya
 * entró con lo limpio y le quedan filas retenidas) y `review` (el archivo entero venía
 * marcado y no se pudo promover nada). Se filtra por esos dos a propósito: sin el filtro,
 * resolver una fila vieja de un documento `reverted` o `failed` lo resucitaría a `promoted`,
 * reinsertando en producción datos que alguien había dado de baja.
 *
 * Se llama SOLO desde el `PATCH`, que es el único camino que resuelve una fila. La
 * re-extracción (`POST /:id/reextract`) reescribe payload/confianza pero deja
 * `review_status` en `pending` a propósito: que Claude reconsidere no es que un humano
 * aprobó, y la fila todavía tiene que pasar por el `PATCH`.
 *
 * Es best-effort y no revienta la respuesta del `PATCH`: la revisión de la fila YA se
 * confirmó y auditó cuando llegamos acá. Si la cola está caída, lo correcto es que el
 * operador vea su cambio guardado —no un 500 que le haga pensar que no se guardó— y que la
 * fila quede pendiente de promover, que es recuperable. Se registra en consola para que el
 * fallo no sea invisible.
 */
async function encolarPromocionDeLoResuelto(
  db: DB,
  companyId: string,
  documentId: string,
): Promise<void> {
  try {
    const [doc] = await db
      .select({ status: documents.status })
      .from(documents)
      .where(eq(documents.id, documentId));
    if (doc?.status !== 'review' && doc?.status !== 'promoted') return;

    await enqueue(QUEUES.documentPromote, { documentId, companyId });
  } catch (err) {
    console.error('[admin/staging-rows] no se pudo encolar la promoción:', documentId, err);
  }
}

export const adminStagingRows = new Elysia({ prefix: '/admin/staging-rows' })
  .use(adminGuard)
  .get(
    '/',
    async ({ tier, query, set, db }) => {
      assertStaffCapability(tier, 'review_flagged_rows', set);
      const conditions = [eq(stagingRows.reviewStatus, 'pending')];
      if (query.companyId) conditions.push(eq(stagingRows.companyId, query.companyId));
      if (query.documentId) conditions.push(eq(stagingRows.documentId, query.documentId));
      // CU-868kfvaz9: sin límite esto cargaba TODAS las filas marcadas cross-tenant
      // en un solo fetch. Pide limit+1 para saber si hay más sin una query de COUNT
      // aparte — patrón "load more", no paginación por cursor completa.
      const limit = Math.min(Number(query.limit ?? 50) || 50, 200);
      const offset = Math.max(Number(query.offset ?? 0) || 0, 0);
      // CU-868khvzqn: se agrega `companyName` con el mismo join que /admin/documents
      // (modules/admin/monitoring.ts). Sin él, el panel de revisión muestra el payload
      // y los botones Aprobar/Rechazar sin decir de qué tenant es la fila: se estaban
      // promoviendo datos a la contabilidad de un cliente sin ver cuál. El UUID no
      // sirve — un operador no lo reconoce.
      //
      // `getTableColumns` mantiene el resto de la respuesta exactamente igual que el
      // `select()` sin argumentos que había antes: solo suma la columna, no cambia la
      // forma existente.
      const rows = await db
        .select({ ...getTableColumns(stagingRows), companyName: companies.name })
        .from(stagingRows)
        .innerJoin(companies, eq(companies.id, stagingRows.companyId))
        .where(and(...conditions))
        .orderBy(asc(stagingRows.createdAt))
        .limit(limit + 1)
        .offset(offset);
      return { rows: rows.slice(0, limit), hasMore: rows.length > limit };
    },
    {
      query: t.Object({
        companyId: t.Optional(t.String()),
        documentId: t.Optional(t.String()),
        limit: t.Optional(t.String()),
        offset: t.Optional(t.String()),
      }),
    },
  )
  .patch(
    '/:id',
    async ({ staffId, tier, params, body, set, db }) => {
      assertStaffCapability(tier, 'review_flagged_rows', set);
      const [before] = await db.select().from(stagingRows).where(eq(stagingRows.id, params.id));
      if (!before) {
        set.status = 404;
        return { error: 'Staging row not found' };
      }

      await db
        .update(stagingRows)
        .set({
          payload: body.payload ?? before.payload,
          reviewStatus: body.reviewStatus,
          reviewedBy: staffId,
          reviewedAt: new Date(),
        })
        .where(eq(stagingRows.id, params.id));

      await logAdminAction(db, {
        actorStaffId: staffId,
        companyId: before.companyId,
        action: 'staging_row.review',
        targetTable: 'staging_rows',
        targetId: params.id,
        metadata: {
          before: before.payload,
          after: body.payload ?? before.payload,
          reviewStatus: body.reviewStatus,
        },
      });

      await encolarPromocionDeLoResuelto(db, before.companyId, before.documentId);

      return { id: params.id, reviewStatus: body.reviewStatus };
    },
    {
      body: t.Object({
        payload: t.Optional(t.Record(t.String(), t.Unknown())),
        reviewStatus: t.Union([t.Literal('approved'), t.Literal('rejected')]),
      }),
    },
  )
  .post('/:id/reextract', async ({ staffId, tier, params, set, db }) => {
    assertStaffCapability(tier, 'review_flagged_rows', set);
    const [row] = await db.select().from(stagingRows).where(eq(stagingRows.id, params.id));
    if (!row) {
      set.status = 404;
      return { error: 'Staging row not found' };
    }

    const [company] = await db.select().from(companies).where(eq(companies.id, row.companyId));
    if (!company) {
      set.status = 404;
      return { error: 'Company not found' };
    }
    // Mismo resolver que el worker de ingesta (lib/industry-template.ts): sin plantilla
    // propia cae a la genérica integrada. Antes eran dos `!` sobre `undefined` — una
    // empresa sin plantilla tumbaba la reextracción con un TypeError, justo en la
    // pantalla donde el staff arregla las filas que esa misma falta de plantilla marcó.
    const templateVersion = await resolveIndustryTemplate(db, company.industry);

    const result = await classifySheetRows({
      templateVersion,
      sheetName: `revisión (${row.flagReason ?? 'sin razón registrada'})`,
      rows: [[JSON.stringify(row.payload)]],
    });

    const [reclassified] = result.rows;
    if (!reclassified) {
      set.status = 502;
      return { error: 'Claude did not return a classification' };
    }

    await db
      .update(stagingRows)
      .set({
        payload: reclassified.payload,
        confidence: String(reclassified.confidence),
        targetEntity: reclassified.targetEntity,
      })
      .where(eq(stagingRows.id, params.id));

    // kind=excel_correction — never debits credits (CLAUDE.md non-negotiable).
    await insertAiUsageEvent(db, {
      companyId: row.companyId,
      kind: 'excel_correction',
      refId: row.documentId,
      model: result.model,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
    });

    await logAdminAction(db, {
      actorStaffId: staffId,
      companyId: row.companyId,
      action: 'staging_row.reextract',
      targetTable: 'staging_rows',
      targetId: params.id,
      metadata: { before: row.payload, after: reclassified.payload },
    });

    return { id: params.id, payload: reclassified.payload, confidence: reclassified.confidence };
  });
