import { Elysia, t } from 'elysia';
import { and, desc, eq, gte, isNull, lte } from 'drizzle-orm';
import { tenantDerive } from '@/guards/tenant.derive';
import { assertClientCapability } from '@/guards/require-capability';
import { enforceTokenBucket, rateLimitedResponse } from '@/lib/rate-limit';
import { transactions } from '@/db/schema';

/**
 * Listado del ledger de transacciones — la pantalla "Transactions" del prototipo.
 *
 * Solo LECTURA. El ledger se escribe únicamente por la promoción atómica del worker de
 * ingesta (CU-868kfva9z) y se deshace por `POST /documents/:id/revert`; no hay alta ni
 * edición manual y este endpoint no la introduce. Que la única vía de entrada de datos
 * financieros siga siendo un Excel promovido es lo que hace auditable el ledger.
 *
 * `view_dashboard_reports` y no una capacidad nueva: es el mismo dato que ya alimenta el
 * dashboard, visto fila por fila en vez de agregado. Quien puede ver el KPI de ingresos
 * puede ver de qué transacciones sale.
 *
 * `deleted_at IS NULL` en el filtro base: revertir un documento hace soft-delete de sus
 * filas (PRD §8), y esas no deben reaparecer aunque sigan en la tabla para la traza.
 */
export const transactionsList = new Elysia({ prefix: '/transactions' }).use(tenantDerive).get(
  '/',
  async ({ companyId, role, query, set, db }) => {
    assertClientCapability(role, 'view_dashboard_reports', set);

    const limited = await enforceTokenBucket('read', companyId, set, 'GET /transactions');
    if (limited) return limited;

    const limit = Math.min(query.limit ?? 50, 200);
    const offset = query.offset ?? 0;

    // `company_id` explícito además del GUC de RLS: la regla no negociable es que el
    // scoping sea del filtro y RLS solo el respaldo, nunca al revés.
    const condiciones = [eq(transactions.companyId, companyId), isNull(transactions.deletedAt)];
    if (query.from) condiciones.push(gte(transactions.date, query.from));
    if (query.to) condiciones.push(lte(transactions.date, query.to));
    if (query.type) condiciones.push(eq(transactions.type, query.type));

    // Una fila de más para saber si hay página siguiente sin un COUNT(*) sobre una tabla
    // particionada, que en un ledger grande cuesta más que la propia página. Mismo patrón
    // que el resto de listados paginados del proyecto.
    const filas = await db
      .select({
        id: transactions.id,
        date: transactions.date,
        type: transactions.type,
        category: transactions.category,
        description: transactions.description,
        originalAmount: transactions.originalAmount,
        originalCurrency: transactions.originalCurrency,
        amountBase: transactions.amountBase,
        documentId: transactions.documentId,
      })
      .from(transactions)
      .where(and(...condiciones))
      .orderBy(desc(transactions.date), desc(transactions.createdAt))
      .limit(limit + 1)
      .offset(offset);

    return { rows: filas.slice(0, limit), hasMore: filas.length > limit };
  },
  {
    query: t.Object({
      limit: t.Optional(t.Numeric({ minimum: 1, maximum: 200 })),
      offset: t.Optional(t.Numeric({ minimum: 0 })),
      /** Fechas YYYY-MM-DD; el filtro es inclusivo en ambos extremos. */
      from: t.Optional(t.String()),
      to: t.Optional(t.String()),
      type: t.Optional(
        t.Union([t.Literal('revenue'), t.Literal('cogs'), t.Literal('opex'), t.Literal('other')]),
      ),
    }),
    response: {
      200: t.Object({
        rows: t.Array(
          t.Object({
            id: t.String(),
            date: t.String(),
            type: t.String(),
            category: t.String(),
            description: t.Union([t.String(), t.Null()]),
            originalAmount: t.String(),
            originalCurrency: t.String(),
            amountBase: t.String(),
            documentId: t.String(),
          }),
        ),
        hasMore: t.Boolean(),
      }),
      429: rateLimitedResponse,
    },
  },
);
