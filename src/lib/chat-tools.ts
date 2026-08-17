import type Anthropic from '@anthropic-ai/sdk';
import { and, desc, eq, gte, lte } from 'drizzle-orm';
import type { DB } from '@/db/client';
import { reports, reportVersions, transactions } from '@/db/schema';
import { getOrComputeMonthlyAmounts, ROLLUP_TYPES, type RollupType } from '@/lib/rollups';

/**
 * CU-868kfvabq: tool-use jerárquico (narrativa → drill-down por rollup → transacciones
 * a nivel hoja), sin RAG ni base vectorial. `companyId` viene SIEMPRE del contexto del
 * servidor (closure), nunca de `input` — ninguna de estas 3 herramientas declara
 * company_id en su JSON schema, así que el modelo no tiene forma de proveerlo
 * (regla no negociable del ticket).
 */
export const CHAT_TOOLS: Anthropic.Tool[] = [
  {
    name: 'get_latest_report_narrative',
    description:
      'Devuelve la narrativa del reporte ejecutivo más reciente de la empresa (Módulo 5/F6), si existe. Úsala primero para tener contexto general antes de profundizar.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'get_monthly_rollup',
    description:
      'Profundiza en las métricas mensuales agregadas (ingresos/costo de ventas/gastos operativos/otros) de los últimos N meses. Úsala antes de pedir transacciones individuales.',
    input_schema: {
      type: 'object',
      properties: {
        months: {
          type: 'integer',
          minimum: 1,
          maximum: 24,
          description: 'Cantidad de meses hacia atrás, incluyendo el actual.',
        },
        type: {
          type: 'string',
          enum: ROLLUP_TYPES,
          description: 'Filtra a un solo tipo; omite para los 4.',
        },
      },
      required: ['months'],
      additionalProperties: false,
    },
  },
  {
    name: 'query_transactions',
    description:
      'Consulta acotada de transacciones a nivel hoja (último recurso, cuando los rollups no alcanzan). Máximo 50 filas por llamada.',
    input_schema: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ROLLUP_TYPES },
        category: { type: 'string' },
        dateFrom: { type: 'string', description: 'YYYY-MM-DD' },
        dateTo: { type: 'string', description: 'YYYY-MM-DD' },
        limit: { type: 'integer', minimum: 1, maximum: 50 },
      },
      additionalProperties: false,
    },
  },
];

export interface ChatToolContext {
  db: DB;
  companyId: string;
}

async function toolLatestReportNarrative(ctx: ChatToolContext): Promise<string> {
  const [latest] = await ctx.db
    .select({ narrative: reportVersions.narrative })
    .from(reportVersions)
    .innerJoin(reports, eq(reports.currentVersionId, reportVersions.id))
    .where(eq(reports.companyId, ctx.companyId))
    .orderBy(desc(reportVersions.createdAt))
    .limit(1);

  return latest?.narrative ?? 'No hay ningún reporte generado todavía para esta empresa.';
}

async function toolMonthlyRollup(
  ctx: ChatToolContext,
  input: { months: number; type?: RollupType },
): Promise<string> {
  const months = Math.min(Math.max(input.months, 1), 24);
  const types = input.type ? [input.type] : ROLLUP_TYPES;

  const periods: string[] = [];
  for (let i = months - 1; i >= 0; i--) {
    const d = new Date();
    d.setUTCDate(1);
    d.setUTCMonth(d.getUTCMonth() - i);
    periods.push(d.toISOString().slice(0, 10));
  }

  // CU-868kh8w6b criterio 3: mismo N+1 que /metrics — hasta 24 meses × 4 tipos = 96
  // round-trips secuenciales, y aquí dentro de un turno de chat, donde la latencia la
  // paga el usuario esperando la respuesta del modelo. Se resuelve en 2 queries.
  const amountsByPeriod = await getOrComputeMonthlyAmounts(ctx.db, ctx.companyId, periods, types);

  const series = periods.map((period) => {
    const all = amountsByPeriod.get(period)!;
    // Solo los tipos pedidos: cuando la herramienta filtra por uno, devolver los 4
    // metería en el contexto del modelo tres números que no pidió.
    const amounts = Object.fromEntries(types.map((type) => [type, all[type]]));
    return { period, ...amounts };
  });
  return JSON.stringify(series);
}

async function toolQueryTransactions(
  ctx: ChatToolContext,
  input: {
    type?: RollupType;
    category?: string;
    dateFrom?: string;
    dateTo?: string;
    limit?: number;
  },
): Promise<string> {
  const limit = Math.min(input.limit ?? 20, 50);
  const conditions = [eq(transactions.companyId, ctx.companyId)];
  if (input.type) conditions.push(eq(transactions.type, input.type));
  if (input.category) conditions.push(eq(transactions.category, input.category));
  if (input.dateFrom) conditions.push(gte(transactions.date, input.dateFrom));
  if (input.dateTo) conditions.push(lte(transactions.date, input.dateTo));

  const rows = await ctx.db
    .select({
      date: transactions.date,
      type: transactions.type,
      category: transactions.category,
      description: transactions.description,
      amountBase: transactions.amountBase,
    })
    .from(transactions)
    .where(and(...conditions))
    .orderBy(desc(transactions.date))
    .limit(limit);

  return JSON.stringify(rows);
}

/** Dispatches a single tool_use block. Never trusts a company_id from `input` — there isn't one to trust, by schema design above. */
/**
 * CU-868krw2gx — UNA HERRAMIENTA QUE FALLA NO PUEDE DEJAR MUDO AL ASESOR.
 *
 * Macha reportó que el asesor no contesta preguntas simples y que, tras insistir, deja de
 * responder del todo. Esta función era una de las dos causas.
 *
 * El `input` de una herramienta lo escribe el MODELO, no un esquema validado: puede mandar
 * `dateFrom: "el mes pasado"`, un `limit` absurdo, o una categoría que no existe. Cuando
 * eso hacía que la consulta lanzara, la excepción subía por `runChatTurn`, salía del
 * endpoint como 500, y el turno entero se perdía — la pregunta del usuario tampoco se
 * guardaba. Una fecha mal escrita por el modelo borraba la conversación.
 *
 * Ahora el fallo se le devuelve AL MODELO como resultado de la herramienta. Es la forma
 * correcta de manejarlo y no un parche: el modelo puede corregir el argumento y reintentar,
 * o decirle al usuario que ese dato no se pudo consultar. En los dos casos el usuario
 * recibe una respuesta, que es justo lo que faltaba.
 *
 * El texto del error NO viaja al modelo. `message` de una excepción de Postgres trae el SQL
 * y nombres de columnas, y esto va dentro de una conversación que el usuario ve. Se manda
 * el nombre de la herramienta y nada más; el detalle queda en el log del servidor, que es
 * donde sirve.
 */
export async function executeChatTool(
  ctx: ChatToolContext,
  name: string,
  input: unknown,
): Promise<string> {
  try {
    switch (name) {
      case 'get_latest_report_narrative':
        return await toolLatestReportNarrative(ctx);
      case 'get_monthly_rollup':
        return await toolMonthlyRollup(ctx, input as { months: number; type?: RollupType });
      case 'query_transactions':
        return await toolQueryTransactions(
          ctx,
          input as {
            type?: RollupType;
            category?: string;
            dateFrom?: string;
            dateTo?: string;
            limit?: number;
          },
        );
      default:
        return `Unknown tool: ${name}`;
    }
  } catch (error) {
    console.error(`[chat-tools] la herramienta "${name}" falló`, error);
    return `ERROR: la herramienta "${name}" no pudo completarse. Si los argumentos pueden estar mal, corrígelos y vuelve a intentar UNA vez; si no, responde al usuario con lo que ya tengas y dile que ese dato no se pudo consultar.`;
  }
}
