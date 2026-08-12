import { eq } from 'drizzle-orm';
import type { DB } from '@/db/client';
import { platformSettings, staff, users } from '@/db/schema';

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
  // CU-868kjc7g5 criterio 3: créditos con los que arranca una empresa nueva. En
  // platform_settings y no en código/env para poder cambiarlo sin desplegar — es un
  // número comercial (cuánto se regala para que el producto se pueda probar), no una
  // constante técnica. Hasta este ticket ninguna empresa recibía créditos jamás: el
  // primer insight devolvía 402 y la alerta de saldo bajo disparaba desde el día uno,
  // porque su porcentaje se calcula sobre un saldo estructuralmente 0.
  creditInitialGrant: 'credit_initial_grant',
} as const;

export async function getPlatformSetting<T>(db: DB, key: string, fallback: T): Promise<T> {
  const [row] = await db.select().from(platformSettings).where(eq(platformSettings.key, key));
  return row ? (row.value as T) : fallback;
}

/**
 * Devuelve además QUIÉN tocó cada parámetro (ronda de QA 2026-08-11, ticket B7).
 *
 * `platform_settings.updated_by` guarda un `staff.id` desde siempre y NUNCA salía de acá,
 * así que el panel solo podía mostrar la fecha. En una pantalla donde se edita el precio
 * del crédito y la equivalencia crédito↔token, "cambió el 9 de agosto" sin decir quién es
 * la mitad del dato: si un número está mal, lo primero que se pregunta es a quién
 * preguntarle.
 *
 * SE DEVUELVE EL CORREO, no el `staff.id`. Un UUID no le dice nada a un operador — es el
 * mismo hallazgo que CU-868khvzqn arregló en `/admin/documents` sumando el nombre de la
 * empresa al join. El camino es `platform_settings.updated_by → staff.id → staff.user_id →
 * users.email`, dos saltos porque `staff` es la identidad interna y `users` la de la
 * persona.
 *
 * `leftJoin` y no `innerJoin`, dos veces: una fila sembrada por `scripts/seed.ts` tiene
 * `updated_by` en NULL, y un staff dado de baja podría quedar sin fila. Con `innerJoin`
 * esas filas DESAPARECERÍAN de la lista — el panel dejaría de mostrar parámetros que
 * existen y se editan, que es mucho peor que no saber quién los tocó.
 */
export async function getAllPlatformSettings(db: DB): Promise<
  {
    key: string;
    value: unknown;
    updatedAt: Date;
    /** `null` cuando la fila viene del seed o el staff ya no existe. */
    updatedByEmail: string | null;
  }[]
> {
  return db
    .select({
      key: platformSettings.key,
      value: platformSettings.value,
      updatedAt: platformSettings.updatedAt,
      updatedByEmail: users.email,
    })
    .from(platformSettings)
    .leftJoin(staff, eq(staff.id, platformSettings.updatedBy))
    .leftJoin(users, eq(users.id, staff.userId));
}

export async function setPlatformSetting(
  db: DB,
  key: string,
  value: unknown,
  updatedBy?: string,
): Promise<void> {
  const [existing] = await db
    .select({ key: platformSettings.key })
    .from(platformSettings)
    .where(eq(platformSettings.key, key));
  if (existing) {
    await db
      .update(platformSettings)
      .set({ value, updatedBy, updatedAt: new Date() })
      .where(eq(platformSettings.key, key));
  } else {
    await db.insert(platformSettings).values({ key, value, updatedBy });
  }
}
