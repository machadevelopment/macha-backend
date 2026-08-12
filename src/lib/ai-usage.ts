import { inArray, sql as rawSql } from 'drizzle-orm';
import type { DB } from '@/db/client';
import { aiUsageEvents } from '@/db/schema';
import { estimateCostUsd } from './anthropic';

/**
 * Inserts one ai_usage_events row per Claude call (CLAUDE.md non-negotiable: "Every
 * Claude call inserts one ai_usage_events row tagged kind"). No prompts or customer
 * data are persisted here — only consumption metadata (ZDR).
 */
export async function insertAiUsageEvent(
  db: DB,
  params: {
    companyId: string;
    kind: 'excel' | 'chat' | 'insight' | 'report_generation' | 'excel_correction';
    refId?: string;
    model: string;
    inputTokens: number;
    outputTokens: number;
    /*
     * Tokens de caché de prompt. Opcionales y default 0 porque no toda llamada manda un
     * bloque cacheable — pero cuando los hay, OMITIRLOS subestima `cost_usd`: la API no
     * los incluye en `input_tokens`, así que lo servido desde caché se costearía como
     * cero. Ver `estimateCostUsd`.
     */
    cacheReadTokens?: number;
    cacheCreationTokens?: number;
    billableUnits?: number;
  },
): Promise<void> {
  await db.insert(aiUsageEvents).values({
    companyId: params.companyId,
    kind: params.kind,
    refId: params.refId,
    model: params.model,
    inputTokens: params.inputTokens,
    outputTokens: params.outputTokens,
    cacheReadInputTokens: params.cacheReadTokens ?? 0,
    cacheCreationInputTokens: params.cacheCreationTokens ?? 0,
    // CU-868kjc9d6: el costo se calcula con la tarifa del MODELO de esta llamada y
    // vigente HOY, no con una constante global. `params.model` es el que de verdad
    // atendió la llamada, que es el único que puede cotizarse bien.
    costUsd: estimateCostUsd(
      params.inputTokens,
      params.outputTokens,
      params.model,
      new Date(),
      params.cacheReadTokens ?? 0,
      params.cacheCreationTokens ?? 0,
    ).toFixed(6),
    billableUnits: params.billableUnits,
  });
}

/**
 * Los cuatro agregados de consumo de IA, definidos UNA sola vez (ticket B5).
 *
 * Los usan dos lecturas distintas y es importante que sigan siendo LA MISMA cuenta:
 *
 *   · `GET /admin/ai-cost` (modules/admin/monitoring.ts) agrupa por empresa Y `kind` —
 *     es el drill-down por tipo de acción.
 *   · `GET /admin/companies/overview` agrupa solo por empresa — es el total que se
 *     muestra en la vista consolidada.
 *
 * Escribir el `sum()` dos veces habría hecho posible que las dos pantallas dieran
 * cifras distintas para la misma empresa (típicamente al ajustar una de ellas y
 * olvidar la otra), que es exactamente la incoherencia que un backoffice de costos no
 * se puede permitir. La ÚNICA diferencia legítima entre ambas es el `GROUP BY`.
 *
 * `sum()` no lleva `coalesce`: un `GROUP BY` nunca produce grupos vacíos, así que toda
 * fila devuelta tiene al menos un evento. La empresa SIN eventos simplemente no sale en
 * el resultado, y el llamador decide qué mostrar (en la vista consolidada, ceros).
 */
export const aiUsageTotals = {
  totalCostUsd: rawSql<string>`sum(${aiUsageEvents.costUsd})`,
  totalInputTokens: rawSql<string>`sum(${aiUsageEvents.inputTokens})`,
  totalOutputTokens: rawSql<string>`sum(${aiUsageEvents.outputTokens})`,
  /*
   * Los dos sumandos que contestan "¿el caché está pegando?" sin abrir el código.
   *
   * Van en el MISMO objeto que los otros totales, y no en una consulta aparte, por la razón
   * que este bloque ya documenta: las dos pantallas que leen consumo tienen que dar la misma
   * cifra. Un agregado de caché definido por separado se desincronizaría igual que se
   * desincronizaría un `sum(cost_usd)` escrito dos veces.
   */
  totalCacheReadTokens: rawSql<string>`sum(${aiUsageEvents.cacheReadInputTokens})`,
  totalCacheCreationTokens: rawSql<string>`sum(${aiUsageEvents.cacheCreationInputTokens})`,
  callCount: rawSql<string>`count(*)`,
} as const;

/**
 * Qué fracción de la entrada llegó desde el caché de prompt.
 *
 * ═══ POR QUÉ ES UNA FUNCIÓN Y NO UNA DIVISIÓN EN LA PANTALLA ═══
 *
 * Es la respuesta a "¿el caché está pegando?", y hay dos pantallas que la van a querer. La
 * misma razón por la que `aiUsageTotals` existe: dos divisiones escritas por separado
 * terminan dando cifras distintas para la misma empresa.
 *
 * ═══ EL DENOMINADOR ES LO ÚNICO DIFÍCIL ACÁ ═══
 *
 * Se divide entre TODA la entrada de la llamada —fresca + escrita + leída— y no solo entre
 * la parte cacheable. Es deliberado y es la lectura conservadora:
 *
 *   · Contra el total, un 20 % significa "una quinta parte de lo que le mandamos vino
 *     barato". Eso es lo que se quiere saber para decidir dónde apretar.
 *   · Contra solo la parte cacheable daría casi 100 % siempre —el prefijo se reusa por
 *     construcción— y se leería como "el caché va perfecto" mientras el 80 % del gasto de
 *     entrada, que son las filas del cliente, no lo toca nadie. Un número que solo puede
 *     dar buenas noticias no sirve para decidir.
 *
 * `cacheCreation` va en el denominador y NO en el numerador: escribir el caché es entrada
 * que se pagó (a 1,25x, más cara que no cachear). Contarla como acierto sería contar el
 * costo como ahorro.
 *
 * Devuelve `null` y no 0 cuando no hubo entrada: "no hay datos" y "el caché no pegó nunca"
 * son cosas distintas, y pintar 0 % en una empresa sin actividad es una alarma falsa.
 */
export function cacheHitRate(totals: {
  totalInputTokens: number;
  totalCacheReadTokens: number;
  totalCacheCreationTokens: number;
}): number | null {
  const total =
    totals.totalInputTokens + totals.totalCacheReadTokens + totals.totalCacheCreationTokens;
  if (total <= 0) return null;
  return totals.totalCacheReadTokens / total;
}

/** Totales de IA acumulados por empresa, para un conjunto acotado de empresas. */
export interface AiUsageTotalsRow {
  totalCostUsd: string;
  totalInputTokens: string;
  totalOutputTokens: string;
  totalCacheReadTokens: string;
  totalCacheCreationTokens: string;
  callCount: string;
}

/**
 * Totales de IA de VARIAS empresas en una sola consulta (ticket B5).
 *
 * Se filtra por los ids de la página que se está pintando y no se agrega la tabla
 * entera: `ai_usage_events` es el ledger que más crece del producto (una fila por
 * llamada a Claude) y la vista consolidada solo necesita las ~50 empresas visibles.
 *
 * Devuelve un `Map` y no un arreglo porque quien llama va a cruzarlo por `companyId`
 * contra su página de empresas; un arreglo obligaría a un `find()` por fila.
 */
export async function getAiUsageTotalsByCompany(
  db: DB,
  companyIds: string[],
): Promise<Map<string, AiUsageTotalsRow>> {
  if (companyIds.length === 0) return new Map();
  const rows = await db
    .select({ companyId: aiUsageEvents.companyId, ...aiUsageTotals })
    .from(aiUsageEvents)
    .where(inArray(aiUsageEvents.companyId, companyIds))
    .groupBy(aiUsageEvents.companyId);
  return new Map(rows.map(({ companyId, ...totals }) => [companyId, totals]));
}
