import { Elysia, t } from 'elysia';
import { and, desc, eq } from 'drizzle-orm';
import { tenantDerive } from '@/guards/tenant.derive';
import { assertClientCapability } from '@/guards/require-capability';
import { alertEvents, alertRules, documents } from '@/db/schema';

/**
 * CU-868kh8jxf. El motor de alertas (`lib/alerts.ts`), `alert_events` y el envío por
 * Resend ya existían desde CU-868kfvad3/CU-868kfvad9; lo que faltaba era el lado
 * consultable: el email enlazaba a `/alerts/{id}` y no había ni ruta en el frontend ni
 * endpoint aquí, así que todo email de alerta caía en un 404.
 *
 * Se devuelve `ruleKey` (estable) y NO la etiqueta del catálogo: `config/alert-catalog.ts`
 * solo tiene labels en español, y el frontend ya traduce por clave (i18n ES/EN,
 * criterio 4). Mandar el label desde aquí volvería a hardcodear español en la UI —
 * exactamente la deuda que arrastra CU-868kh8rz8.
 *
 * `threshold` y `triggeredValue` son `numeric` en la base y salen como string (regla no
 * negociable de dinero/precisión: nunca los pasa por float el servidor). El frontend
 * los formatea con sus helpers locale-aware.
 */
export const alerts = new Elysia({ prefix: '/alerts' })
  .use(tenantDerive)
  .get(
    '/',
    async ({ companyId, role, query, set, db }) => {
      assertClientCapability(role, 'view_dashboard_reports', set);

      // Patrón limit+1 ya establecido en modules/admin/monitoring.ts y staging-rows.ts:
      // se pide una fila de más para saber si hay siguiente página sin un COUNT aparte.
      const limit = query.limit ?? 20;
      const offset = query.offset ?? 0;
      const rows = await db
        .select({
          id: alertEvents.id,
          ruleKey: alertRules.ruleKey,
          threshold: alertRules.threshold,
          triggeredValue: alertEvents.triggeredValue,
          createdAt: alertEvents.createdAt,
        })
        .from(alertEvents)
        .innerJoin(alertRules, eq(alertRules.id, alertEvents.alertRuleId))
        .where(eq(alertEvents.companyId, companyId))
        .orderBy(desc(alertEvents.createdAt))
        .limit(limit + 1)
        .offset(offset);

      return {
        items: rows.slice(0, limit).map((r) => ({
          id: r.id,
          ruleKey: r.ruleKey,
          threshold: r.threshold,
          triggeredValue: r.triggeredValue,
          createdAt: r.createdAt.toISOString(),
        })),
        hasMore: rows.length > limit,
      };
    },
    {
      query: t.Object({
        limit: t.Optional(t.Numeric({ minimum: 1, maximum: 100 })),
        offset: t.Optional(t.Numeric({ minimum: 0 })),
      }),
      response: t.Object({
        items: t.Array(
          t.Object({
            id: t.String(),
            ruleKey: t.String(),
            threshold: t.String(),
            triggeredValue: t.String(),
            createdAt: t.String(),
          }),
        ),
        hasMore: t.Boolean(),
      }),
    },
  )
  .get(
    '/:id',
    async ({ companyId, role, params, set, db }) => {
      assertClientCapability(role, 'view_dashboard_reports', set);

      // Criterio 2: el filtro por company_id va en el WHERE, no en un chequeo posterior
      // — un alert_event de otra empresa es indistinguible de uno inexistente (404),
      // nunca devuelve datos ni confirma su existencia.
      const [event] = await db
        .select({
          id: alertEvents.id,
          ruleKey: alertRules.ruleKey,
          threshold: alertRules.threshold,
          notifyImmediately: alertRules.notifyImmediately,
          triggeredValue: alertEvents.triggeredValue,
          createdAt: alertEvents.createdAt,
          documentId: alertEvents.documentId,
        })
        .from(alertEvents)
        .innerJoin(alertRules, eq(alertRules.id, alertEvents.alertRuleId))
        .where(and(eq(alertEvents.id, params.id), eq(alertEvents.companyId, companyId)));

      if (!event) {
        set.status = 404;
        return { error: 'Alert not found' };
      }

      // El documento asociado es el Excel cuya ingesta disparó la evaluación
      // (`evaluateAlerts(db, companyId, documentId)`); puede no existir cuando la
      // alerta la dispara el tick periódico en vez de una carga.
      let document: { id: string; originalFilename: string } | null = null;
      if (event.documentId) {
        const [doc] = await db
          .select({ id: documents.id, originalFilename: documents.originalFilename })
          .from(documents)
          .where(and(eq(documents.id, event.documentId), eq(documents.companyId, companyId)));
        document = doc ?? null;
      }

      return {
        id: event.id,
        ruleKey: event.ruleKey,
        threshold: event.threshold,
        triggeredValue: event.triggeredValue,
        notifyImmediately: event.notifyImmediately,
        createdAt: event.createdAt.toISOString(),
        document,
      };
    },
    {
      params: t.Object({ id: t.String() }),
    },
  );
