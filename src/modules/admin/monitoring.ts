import { Elysia } from 'elysia';
import { desc, eq, sql as rawSql } from 'drizzle-orm';
import { adminGuard } from '@/guards/admin.guard';
import { assertStaffCapability } from '@/guards/require-capability';
import { db } from '@/db/client';
import { aiUsageEvents, companies, documents } from '@/db/schema';

/**
 * CU-868kfvag7: costo de IA por empresa (SUM(cost_usd) GROUP BY company_id, con
 * drill-down por kind) + monitoreo de uploads/procesos. Costo real en USD/tokens
 * queda SOLO aquí (staff/super_admin) — el cliente nunca lo ve (criterio 3), solo su
 * saldo en créditos (GET /credits/balance, F4).
 */
export const adminMonitoring = new Elysia({ prefix: '/admin' })
  .use(adminGuard)
  .get('/ai-cost', async ({ tier, set }) => {
    assertStaffCapability(tier, 'view_ai_usage_cost', set);
    return db
      .select({
        companyId: aiUsageEvents.companyId,
        companyName: companies.name,
        kind: aiUsageEvents.kind,
        totalCostUsd: rawSql<string>`sum(${aiUsageEvents.costUsd})`,
        totalInputTokens: rawSql<string>`sum(${aiUsageEvents.inputTokens})`,
        totalOutputTokens: rawSql<string>`sum(${aiUsageEvents.outputTokens})`,
        callCount: rawSql<string>`count(*)`,
      })
      .from(aiUsageEvents)
      .innerJoin(companies, eq(companies.id, aiUsageEvents.companyId))
      .groupBy(aiUsageEvents.companyId, companies.name, aiUsageEvents.kind);
  })
  .get('/documents', async ({ tier, set }) => {
    assertStaffCapability(tier, 'view_job_status', set);
    return db
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
      .limit(200);
  });
