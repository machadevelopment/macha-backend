import { eq } from 'drizzle-orm';
import type { DB } from '@/db/client';
import { platformSettings } from '@/db/schema';

// CU-868kfvafy criterio 1 (no negociable): créditos↔tokens y el catálogo de prompts
// de insight configurables desde el panel, nunca en código. Estas son las claves +
// defaults de arranque (sembrados en scripts/seed.ts) — el código nunca hardcodea el
// VALOR, solo el fallback si la fila aún no existe (entorno recién migrado).
export const SETTINGS_KEYS = {
  creditToTokensRatio: 'credit_to_tokens_ratio',
  creditMonthlyAllotment: 'credit_monthly_allotment',
  insightPromptTemplate: 'insight_prompt_template',
  // CU-868kfvaet: precio de venta por crédito (USD, en centavos) — no existe en
  // ningún lado del data model/PRD/tickets; es una decisión de negocio real que
  // falta confirmar con Jose/el owner. Provisional a propósito (10 centavos =
  // $0.10/crédito), holgado como el resto de placeholders de F0.
  creditPriceUsdCents: 'credit_price_usd_cents',
} as const;

export async function getPlatformSetting<T>(db: DB, key: string, fallback: T): Promise<T> {
  const [row] = await db.select().from(platformSettings).where(eq(platformSettings.key, key));
  return row ? (row.value as T) : fallback;
}

export async function getAllPlatformSettings(db: DB): Promise<{ key: string; value: unknown; updatedAt: Date }[]> {
  return db
    .select({ key: platformSettings.key, value: platformSettings.value, updatedAt: platformSettings.updatedAt })
    .from(platformSettings);
}

export async function setPlatformSetting(
  db: DB,
  key: string,
  value: unknown,
  updatedBy?: string,
): Promise<void> {
  const [existing] = await db.select({ key: platformSettings.key }).from(platformSettings).where(eq(platformSettings.key, key));
  if (existing) {
    await db
      .update(platformSettings)
      .set({ value, updatedBy, updatedAt: new Date() })
      .where(eq(platformSettings.key, key));
  } else {
    await db.insert(platformSettings).values({ key, value, updatedBy });
  }
}
