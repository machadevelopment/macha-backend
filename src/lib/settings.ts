import { eq } from 'drizzle-orm';
import type { DB } from '@/db/client';
import { platformSettings, staff, users } from '@/db/schema';
import { creditsConfig } from '@/config/credits';
import { DEFAULT_INSIGHT_PROMPT } from '@/lib/anthropic';

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

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * EL VALOR DE ARRANQUE DE CADA PARÁMETRO, EN UN SOLO LUGAR
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *
 * Jose reportó (2026-08-20) que "Parámetros de negocio" no tiene funcionalidad alguna y está en
 * blanco. Verificado contra la base de PRODUCCIÓN: `platform_settings` tiene **0 filas**.
 *
 * La pantalla no está vacía por construcción — `ConfigPanel` lee, muestra y edita cualquier
 * parámetro que exista. Está vacía porque los valores se siembran con `scripts/seed.ts`, que es
 * un script de desarrollo, y en producción nunca corrió.
 *
 * ═══ PERO EL BUG NO ES "FALTA CORRER EL SEED" ═══
 *
 * Ahí está lo que hace esto peor que una pantalla vacía: `getPlatformSetting` recibe un
 * FALLBACK y lo usa cuando la fila no existe. O sea que producción **sí tiene cinco parámetros
 * en efecto ahora mismo** —el sistema los está usando para calcular créditos y armar el prompt
 * de insights— y el panel muestra cero.
 *
 * Un panel de configuración que oculta la configuración vigente es peor que uno que no existe:
 * quien entra concluye que no hay nada configurado, cuando lo que hay es una configuración que
 * no puede ver ni cambiar. Y correr el seed contra producción no lo arregla de raíz: lo tapa
 * hasta el próximo entorno, y hace un INSERT de valores que ya estaban en efecto.
 *
 * El arreglo es que el panel liste las claves QUE EL PRODUCTO TIENE, con su valor efectivo y de
 * dónde sale. Sin escribir nada en la base: la fila se crea recién cuando alguien edita.
 *
 * ═══ POR QUÉ LOS DEFAULTS VIVEN ACÁ Y NO EN CADA LLAMADOR ═══
 *
 * Cada `getPlatformSetting(db, clave, fallback)` sigue pasando el suyo, y eso NO cambia: en
 * `credit_monthly_allotment` el fallback correcto es `creditsConfig.monthlyAllotment`, que viene
 * de una variable de entorno y puede diferir por entorno. Este mapa es para RESPONDER "¿qué
 * valor está en efecto?" desde el panel, y tiene que dar el mismo que daría el llamador.
 *
 * Si los dos se separan, el panel muestra un número y el sistema usa otro — el peor resultado
 * posible en una pantalla de configuración. Hay test que compara este mapa contra los fallbacks
 * reales de los llamadores.
 */
export const SETTINGS_DEFAULTS: Record<string, () => unknown> = {
  [SETTINGS_KEYS.creditMonthlyAllotment]: () => creditsConfig.monthlyAllotment,
  /* El grant inicial cae al mismo número que la asignación mensual: es el fallback que usa
     `lib/credits.ts`, no una elección de acá. */
  [SETTINGS_KEYS.creditInitialGrant]: () => creditsConfig.monthlyAllotment,
  [SETTINGS_KEYS.creditPriceUsdCents]: () => 10,
  [SETTINGS_KEYS.insightPromptTemplate]: () => DEFAULT_INSIGHT_PROMPT,
  /*
   * ⚠️ ESTA CLAVE NO LA CONSUME NADIE, y sale en el panel como si sí.
   *
   * `credit_to_tokens_ratio` está declarada desde CU-868kfvafy como "configurable desde el
   * panel, nunca en código". Buscado en todo `src`: el único lugar que menciona la equivalencia
   * es `config/credits.ts` leyendo `CREDIT_TO_TOKENS_RATIO`, y ese valor **no se usa en ninguna
   * parte**. No hay un solo `getPlatformSetting` para esta clave.
   *
   * O sea que un operador la edita, ve que se guardó, y no pasa nada. Se deja listada —ocultarla
   * sería esconder el problema— y se muestra el número de la variable de entorno, que es lo
   * único que existe. Conectarla es una decisión de producto (dónde se aplica la conversión), no
   * un arreglo de panel.
   */
  [SETTINGS_KEYS.creditToTokensRatio]: () => creditsConfig.creditToTokensRatio,
};

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
    /** `null` cuando el parámetro todavía no tiene fila: nadie lo editó nunca. */
    updatedAt: Date | null;
    /** `null` cuando la fila viene del seed, no tiene fila, o el staff ya no existe. */
    updatedByEmail: string | null;
    /** `stored` = alguien lo decidió y está en la base · `default` = valor de arranque. */
    source: 'stored' | 'default';
  }[]
> {
  const guardadas = await db
    .select({
      key: platformSettings.key,
      value: platformSettings.value,
      updatedAt: platformSettings.updatedAt,
      updatedByEmail: users.email,
    })
    .from(platformSettings)
    .leftJoin(staff, eq(staff.id, platformSettings.updatedBy))
    .leftJoin(users, eq(users.id, staff.userId));

  /*
   * Se completan las claves que el producto TIENE y la tabla todavía no. Ver la nota de
   * `SETTINGS_DEFAULTS`: sin esto, un entorno donde nunca corrió el seed —producción, hoy—
   * muestra una pantalla en blanco mientras el sistema usa cinco valores por defecto.
   *
   * `source` no es decoración: es la diferencia entre "alguien decidió este número" y "este es
   * el número con el que arrancó el producto". En una pantalla donde se edita el precio del
   * crédito, eso cambia si conviene tocarlo o no.
   */
  const presentes = new Set(guardadas.map((f) => f.key));
  const faltantes = Object.entries(SETTINGS_DEFAULTS)
    .filter(([key]) => !presentes.has(key))
    .map(([key, valorPorDefecto]) => ({
      key,
      value: valorPorDefecto(),
      /* NULL y no `now()`: nadie la editó nunca, y poner una fecha inventada haría creer que
         alguien la revisó hoy. */
      updatedAt: null,
      updatedByEmail: null,
      source: 'default' as const,
    }));

  return [...guardadas.map((f) => ({ ...f, source: 'stored' as const })), ...faltantes].sort(
    (a, b) => a.key.localeCompare(b.key),
  );
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
