import { Elysia, t } from 'elysia';
import { desc, eq } from 'drizzle-orm';
import { adminGuard } from '@/guards/admin.guard';
import { assertStaffCapability } from '@/guards/require-capability';
import { aiUsageEvents, companies, documents } from '@/db/schema';
import { aiUsageTotals, cacheHitRate } from '@/lib/ai-usage';

/**
 * CU-868kfvag7: costo de IA por empresa (SUM(cost_usd) GROUP BY company_id, con
 * drill-down por kind) + monitoreo de uploads/procesos. Costo real en USD/tokens
 * queda SOLO aquí (staff/super_admin) — el cliente nunca lo ve (criterio 3), solo su
 * saldo en créditos (GET /credits/balance, F4).
 *
 * Ticket B5: este endpoint SIGUE SIENDO el drill-down por tipo de acción y no lo
 * reemplaza la vista consolidada — `GET /admin/companies/overview` da el TOTAL por
 * empresa, y para saber en qué se fue ese total (excel/chat/insight/…) se sigue
 * viniendo aquí. Los agregados los definen los dos desde `lib/ai-usage.ts` para que no
 * puedan dejar de cuadrar.
 */
export const adminMonitoring = new Elysia({ prefix: '/admin' })
  .use(adminGuard)
  .get('/ai-cost', async ({ tier, set, db }) => {
    assertStaffCapability(tier, 'view_ai_usage_cost', set);
    const rows = await db
      .select({
        companyId: aiUsageEvents.companyId,
        companyName: companies.name,
        kind: aiUsageEvents.kind,
        ...aiUsageTotals,
      })
      .from(aiUsageEvents)
      .innerJoin(companies, eq(companies.id, aiUsageEvents.companyId))
      .groupBy(aiUsageEvents.companyId, companies.name, aiUsageEvents.kind);

    /*
     * La tasa de acierto del caché se calcula ACÁ y no en el panel, por la misma razón por
     * la que los `sum()` viven en `aiUsageTotals`: es una cifra que dos pantallas van a
     * mostrar y que no puede diferir entre ellas.
     *
     * Los `sum()` de Postgres llegan como string (numeric/bigint no caben en un number de
     * JS sin perder precisión). Se convierten solo para el cociente, que es un ratio chico
     * y no arrastra el problema; los totales siguen viajando como string.
     */
    return rows.map((r) => ({
      ...r,
      cacheHitRate: cacheHitRate({
        totalInputTokens: Number(r.totalInputTokens),
        totalCacheReadTokens: Number(r.totalCacheReadTokens),
        totalCacheCreationTokens: Number(r.totalCacheCreationTokens),
      }),
    }));
  })
  .get(
    '/documents',
    async ({ tier, query, set, db }) => {
      assertStaffCapability(tier, 'view_job_status', set);
      // CU-868kfvaz9: "load more" — limit+1 para saber si hay más sin COUNT aparte.
      const limit = Math.min(Number(query.limit ?? 50) || 50, 200);
      const offset = Math.max(Number(query.offset ?? 0) || 0, 0);
      const rows = await db
        .select({
          id: documents.id,
          companyId: documents.companyId,
          companyName: companies.name,
          originalFilename: documents.originalFilename,
          status: documents.status,
          rowCount: documents.rowCount,
          flaggedCount: documents.flaggedCount,
          errorReason: documents.errorReason,
          createdAt: documents.createdAt,
        })
        .from(documents)
        .innerJoin(companies, eq(companies.id, documents.companyId))
        .orderBy(desc(documents.createdAt))
        .limit(limit + 1)
        .offset(offset);
      return { rows: rows.slice(0, limit), hasMore: rows.length > limit };
    },
    { query: t.Object({ limit: t.Optional(t.String()), offset: t.Optional(t.String()) }) },
  );
