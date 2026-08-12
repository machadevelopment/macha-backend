import type Anthropic from '@anthropic-ai/sdk';
import { and, asc, eq, isNotNull, sql } from 'drizzle-orm';
import type { DB } from '@/db/client';
import { industryTemplates, industryTemplateVersions } from '@/db/schema';
import {
  DEFAULT_INDUSTRY_TEMPLATE,
  DEFAULT_INDUSTRY_TEMPLATE_NAME,
  type IndustryTemplatePayload,
} from '@/config/default-industry-template';

type TemplateVersionPayload = IndustryTemplatePayload;

/**
 * Forma canónica de una industria: minúsculas y sin espacios sobrantes.
 *
 * La industria es texto libre —la escribe el cliente en el registro autoservicio y el
 * staff en el alta manual— así que "TECH", "Tech" y " tech " son la misma industria
 * para cualquier humano y tres distintas para un `=`. Se normaliza al ESCRIBIR (para
 * que los datos nuevos sean consistentes) y se compara normalizado al LEER (para que
 * los datos que ya existen, escritos antes de esto, también resuelvan).
 */
export function normalizeIndustry(raw: string): string {
  return raw.trim().toLowerCase();
}

export interface ResolvedIndustryTemplate extends TemplateVersionPayload {
  /** `industry` = fila de `industry_templates`; `default` = fallback integrado. */
  source: 'industry' | 'default';
  templateName: string;
}

/**
 * Resuelve el diccionario de mapeo que se le manda a Claude para una industria.
 *
 * NUNCA falla por falta de plantilla: si la industria no tiene una configurada (o la
 * tiene sin versión activa), cae al template genérico integrado
 * (config/default-industry-template.ts). Ese es el punto de todo esto — antes cada
 * llamador lanzaba o hacía `!` sobre un `undefined`, y el cliente terminaba con un
 * documento en `failed` por un detalle interno que no puede resolver.
 *
 * Único punto de resolución: lo usan el worker de ingesta, la reextracción del panel
 * admin y la plantilla Excel descargable. Antes cada uno repetía el par de queries con
 * su propio criterio de fallo, y divergían.
 */
export async function resolveIndustryTemplate(
  db: DB,
  industry: string,
): Promise<ResolvedIndustryTemplate> {
  const normalized = normalizeIndustry(industry);

  const [match] = await db
    .select({
      templateName: industryTemplates.name,
      synonyms: industryTemplateVersions.synonyms,
      fewShot: industryTemplateVersions.fewShot,
    })
    .from(industryTemplates)
    .innerJoin(
      industryTemplateVersions,
      eq(industryTemplateVersions.id, industryTemplates.currentVersionId),
    )
    .where(
      and(
        isNotNull(industryTemplates.currentVersionId),
        eq(sql`lower(btrim(${industryTemplates.industry}))`, normalized),
      ),
    )
    // El índice único de `industry_templates.industry` distingue mayúsculas, así que en
    // teoría "Retail" y "retail" pueden coexistir (filas anteriores a la normalización
    // al escribir). Se ordena por creación para que, si eso pasa, el ganador sea
    // estable entre llamadas y no dependa del plan del query.
    .orderBy(asc(industryTemplates.createdAt))
    .limit(1);

  if (match) {
    return {
      synonyms: match.synonyms,
      fewShot: match.fewShot,
      source: 'industry',
      templateName: match.templateName,
    };
  }

  return {
    ...DEFAULT_INDUSTRY_TEMPLATE,
    source: 'default',
    templateName: DEFAULT_INDUSTRY_TEMPLATE_NAME,
  };
}

/**
 * Builds the industry template (synonyms + few-shot) as a cache-eligible content
 * block — CU-868kfva91. Marked `cache_control: ephemeral` because the SAME block is
 * sent on every sheet-classification call for a given document (one call per sheet,
 * CU-868kfva8v): Anthropic prompt caching keeps the repeated schema/synonyms load
 * cheap instead of re-billing full price on every sheet.
 */
export function buildIndustryTemplateBlock(
  version: TemplateVersionPayload,
): Anthropic.TextBlockParam {
  /*
   * Los ejemplos se PROYECTAN a lo que el modelo devuelve hoy, no se muestran crudos.
   *
   * Los `fewShot` guardados (los sembrados y los que cura el staff) traen la `output` del
   * esquema viejo: la fila entera reconstruida, con fecha, monto y descripción. Desde el
   * recorte del 2026-08-12 (lib/row-assembly.ts) el modelo ya no devuelve nada de eso —
   * devuelve entidad, tipo, categoría y confianza, y los valores los arma el código.
   *
   * Mostrarlos crudos sería enseñarle un formato que tiene prohibido producir: structured
   * output le impediría copiarlo, pero el ejemplo seguiría empujando en la dirección
   * equivocada, y encima cada uno cuesta tokens de entrada en cada llamada. Se proyecta acá
   * y no se migran los datos: la tabla es append-only y los ejemplos siguen siendo válidos
   * como criterio de clasificación, que es para lo único que se usan.
   */
  const fewShotText = version.fewShot
    .map((example, i) => {
      /*
       * Se aceptan las DOS formas que existen en la base: la anidada
       * (`{targetEntity, confidence, payload:{type, category}}`, la de los ejemplos
       * sembrados) y la plana (`{type, category}`, que es como los escribe parte del
       * staff en el panel). `fewShot.output` está tipado como `Record<string, unknown>`,
       * o sea que la tabla nunca garantizó una sola forma — leer solo la anidada dejaría
       * los ejemplos curados a mano proyectados a puros `null`, que es peor que no
       * mandarlos: enseñaría a no clasificar.
       */
      const salida = example.output as {
        targetEntity?: unknown;
        confidence?: unknown;
        type?: unknown;
        category?: unknown;
        payload?: { type?: unknown; category?: unknown };
      };
      const clasificacion = {
        e: salida.targetEntity ?? null,
        t: salida.payload?.type ?? salida.type ?? null,
        c: salida.payload?.category ?? salida.category ?? null,
        cf: salida.confidence ?? null,
      };
      return `Ejemplo ${i + 1}:\nFila: ${example.input}\nClasificación: ${JSON.stringify(clasificacion)}`;
    })
    .join('\n\n');

  return {
    type: 'text',
    text:
      'REFERENCIA DE APOYO (no es una lista cerrada). Sinónimos ya conocidos para ' +
      'nombrar igual lo que ya tiene nombre, sobre la taxonomía fija ' +
      '(type: revenue/cogs/opex/other). Si un encabezado o descripción no aparece aquí, ' +
      'clasifícalo igual con tu propio criterio contable — este bloque no limita lo que ' +
      `puedes mapear:\n${JSON.stringify(version.synonyms, null, 2)}` +
      `\n\nEjemplos de clasificación (solo el criterio: entidad, tipo, categoría y confianza — los valores de la fila no se devuelven):\n${fewShotText}`,
    cache_control: { type: 'ephemeral' },
  };
}
