import type Anthropic from '@anthropic-ai/sdk';
import { and, desc, eq, gte, isNotNull, isNull, lte, sql as rawSql } from 'drizzle-orm';
import type { DB } from '@/db/client';
import {
  alertEvents,
  alertRules,
  reports,
  reportVersions,
  stores,
  transactions,
} from '@/db/schema';
import { getOrComputeMonthlyAmounts, ROLLUP_TYPES, type RollupType } from '@/lib/rollups';
import { alertCatalog } from '@/config/alert-catalog';

/**
 * CU-868kfvabq: tool-use jerárquico (narrativa → drill-down por rollup → transacciones
 * a nivel hoja), sin RAG ni base vectorial. `companyId` viene SIEMPRE del contexto del
 * servidor (closure), nunca de `input` — ninguna de estas herramientas declara
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
    /*
     * CU-868kt8kk9. Macha preguntó "¿qué tienda ha vendido más?" y el asesor respondió que
     * no tenía esa información — con razón: la dimensión no se ingería, y aunque ahora sí,
     * ninguna herramienta sabía consultarla. Un dato en la base que el asesor no puede leer
     * es, para el usuario, un dato que no existe.
     *
     * Es una herramienta propia y no un parámetro de `query_transactions` porque la
     * pregunta es de RANKING, no de listado: devolver cien ventas para que el modelo las
     * sume es gastar tokens en una cuenta que Postgres hace en una consulta — y que el
     * modelo sume mal es justamente lo que la regla de "narra, nunca calcula" evita.
     */
    name: 'get_sales_by_store',
    description:
      'Ranking de tiendas/sucursales por ventas en un rango de fechas. Úsala para "qué tienda vendió más", "cómo va la sucursal X" o cualquier comparación entre locales. Devuelve vacío si el archivo del cliente no traía columna de tienda.',
    input_schema: {
      type: 'object',
      properties: {
        dateFrom: { type: 'string', description: 'YYYY-MM-DD. Omite para no acotar por abajo.' },
        dateTo: { type: 'string', description: 'YYYY-MM-DD. Omite para no acotar por arriba.' },
      },
      additionalProperties: false,
    },
  },
  {
    /*
     * CU-868kt94an. El usuario le preguntó al asesor por una alerta que estaba viendo en
     * su panel, y el asesor le contestó que esa alerta "no existe" y le pidió que le
     * pegara "el texto exacto". Tenía razón desde su lado: no había forma de consultarlas.
     * Un sistema que manda un correo de alerta y después no puede hablar de ella no es un
     * asesor, es dos productos distintos con el mismo nombre.
     *
     * Devuelve el valor GUARDADO en el evento, no uno recalculado, y por eso importa que
     * ahora `alert_events` lleve período y línea base (migración 0032): con esos tres
     * datos el asesor puede explicar la alerta EXACTAMENTE como el panel la muestra, en
     * vez de rehacer la cuenta con otra ventana y salir con un tercer número — que es
     * justo lo que hizo (52,3 % en el panel, 64,9 % en el chat, las dos correctas para
     * ventanas distintas y ninguna diciendo cuál era la suya).
     */
    name: 'get_active_alerts',
    description:
      'Alertas que el sistema disparó para esta empresa, con su valor, su umbral y el período que se evaluó. Úsala SIEMPRE que el usuario mencione una alerta, un aviso o un correo del sistema — nunca recalcules una alerta por tu cuenta.',
    input_schema: {
      type: 'object',
      properties: {
        limit: { type: 'integer', minimum: 1, maximum: 20, description: 'Máximo 20.' },
      },
      additionalProperties: false,
    },
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

/**
 * Ventas por tienda, agregadas en SQL — CU-868kt8kk9.
 *
 * Postgres agrupa y ordena; el modelo solo narra el resultado. Es la misma división de
 * trabajo que el resto del producto ("la IA narra, nunca calcula") y acá además ahorra
 * tokens: la alternativa era devolverle cientos de ventas para que las sumara.
 *
 * `store_id IS NOT NULL` deja fuera las filas sin tienda en vez de agruparlas bajo una
 * etiqueta inventada: mezclar "lo que no sabemos de qué local es" con un local real
 * produciría un ranking donde el primer puesto podría ser el desconocido.
 *
 * El mensaje del caso vacío DICE POR QUÉ está vacío. Si el asesor solo viera una lista sin
 * filas, volvería a contestar "no tengo esa información" — que es exactamente el reporte
 * del ticket. Distinguir "tu archivo no traía tiendas" de "no puedo consultarlo" es lo que
 * convierte una respuesta inútil en una accionable.
 */
async function toolSalesByStore(
  ctx: ChatToolContext,
  input: { dateFrom?: string; dateTo?: string },
): Promise<string> {
  const condiciones = [
    eq(transactions.companyId, ctx.companyId),
    isNull(transactions.deletedAt),
    eq(transactions.type, 'revenue'),
    isNotNull(transactions.storeId),
  ];
  if (input.dateFrom) condiciones.push(gte(transactions.date, input.dateFrom));
  if (input.dateTo) condiciones.push(lte(transactions.date, input.dateTo));

  const filas = await ctx.db
    .select({
      tienda: stores.name,
      total: rawSql<string>`sum(${transactions.amountBase})`,
      ventas: rawSql<string>`count(*)`,
    })
    .from(transactions)
    .innerJoin(stores, eq(stores.id, transactions.storeId))
    .where(and(...condiciones))
    .groupBy(stores.name)
    .orderBy(desc(rawSql`sum(${transactions.amountBase})`))
    .limit(20);

  if (filas.length === 0) {
    return 'No hay ventas con tienda asociada. El archivo que subió el cliente no traía una columna de tienda o sucursal, así que no se puede comparar por local. Dilo así: el dato no está en su archivo, no es que no se pueda consultar.';
  }

  return JSON.stringify(
    filas.map((f) => ({
      tienda: f.tienda,
      ventas: Number(f.total),
      transacciones: Number(f.ventas),
    })),
  );
}

/**
 * Las alertas de la empresa, tal como se guardaron — CU-868kt94an.
 *
 * NO recalcula nada. El valor, el umbral y el período salen de la fila; si el asesor
 * rehiciera la cuenta volvería a pasar lo del reporte: dos números correctos para dos
 * ventanas distintas, y el usuario en el medio sin saber a cuál creerle.
 *
 * `periodStart` puede venir NULL en los eventos anteriores a la migración 0032, y en ese
 * caso se dice explícitamente en vez de omitir el campo: que el asesor sepa que ese dato
 * no está es distinto de que crea que la alerta no tiene período.
 */
async function toolActiveAlerts(ctx: ChatToolContext, input: { limit?: number }): Promise<string> {
  const limit = Math.min(Math.max(input.limit ?? 10, 1), 20);
  const filas = await ctx.db
    .select({
      regla: alertRules.ruleKey,
      umbral: alertRules.threshold,
      valor: alertEvents.triggeredValue,
      base: alertEvents.baselineValue,
      desde: alertEvents.periodStart,
      hasta: alertEvents.periodEnd,
      cuando: alertEvents.createdAt,
    })
    .from(alertEvents)
    .innerJoin(alertRules, eq(alertRules.id, alertEvents.alertRuleId))
    .where(eq(alertEvents.companyId, ctx.companyId))
    .orderBy(desc(alertEvents.createdAt))
    .limit(limit);

  if (filas.length === 0) {
    return 'Esta empresa no tiene ninguna alerta disparada. Dilo así: no hay alertas registradas, no que no puedas consultarlas.';
  }

  return JSON.stringify(
    filas.map((f) => ({
      regla: f.regla,
      etiqueta: alertCatalog.find((c) => c.ruleKey === f.regla)?.label ?? f.regla,
      valor: Number(f.valor),
      umbral: Number(f.umbral),
      comparadoContra: f.base === null ? null : Number(f.base),
      periodo: f.desde
        ? { desde: f.desde, hasta: f.hasta }
        : 'no registrado (alerta anterior a que se guardara el período)',
      disparadaEl: f.cuando.toISOString().slice(0, 10),
    })),
  );
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
      case 'get_active_alerts':
        return await toolActiveAlerts(ctx, input as { limit?: number });
      case 'get_sales_by_store':
        return await toolSalesByStore(ctx, input as { dateFrom?: string; dateTo?: string });
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
