/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LAS INDUSTRIAS OBJETIVO (lista de Jose, 2026-08-25)
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *
 * Era uno de los insumos pendientes del Brief §13 y tenía bloqueado el onboarding por industria:
 * hasta ahora un cliente nuevo solo recibía la plantilla de Excel GENÉRICA, porque no había
 * lista contra la cual ofrecerle la de su rubro.
 *
 * ═══ POR QUÉ EL SLUG Y NO EL NOMBRE ═══
 *
 * `companies.industry` es texto libre y `normalizeIndustry` lo baja a minúsculas — sin eso,
 * "Retail" y "retail" serían dos industrias distintas y cada una buscaría su propia plantilla.
 * Estos slugs son lo que se guarda y lo que `industry_starter_templates` e
 * `industry_template_versions` usan como llave.
 *
 * `retail` se conserva tal cual porque ya hay empresas guardadas con ese valor: cambiarlo por
 * `comercio_minorista` las dejaría sin su plantilla en silencio.
 *
 * ═══ LOS NOMBRES VISIBLES NO ESTÁN ACÁ ═══
 *
 * El backend no es dueño de la copia de la interfaz: los rótulos viven en el diccionario del
 * frontend, en los dos idiomas. Acá está la lista que decide QUÉ plantilla se sirve.
 *
 * La duplicación entre repos es real y hay que decirla — son dos repos, no un monorepo. Lo que
 * la hace tolerable es cómo degrada: un slug que el frontend ofrezca y este archivo no conozca
 * cae en la plantilla genérica, que es exactamente el comportamiento de hoy. Nada se rompe;
 * como mucho, no mejora.
 *
 * ═══ NO TODAS TIENEN PLANTILLA CURADA TODAVÍA, Y ESO ESTÁ BIEN ═══
 *
 * `GET /industry-templates/download` sirve el archivo curado que staff subió y **sigue
 * generando uno al vuelo si no hay** (ver ese módulo). O sea que las 28 se pueden ofrecer hoy
 * mismo: la que todavía no tiene archivo propio recibe uno generado, no un enlace roto. Jose lo
 * dejó abierto en su mensaje —"si hace falta afinar cuáles van primero contra cuáles quedan en
 * la genérica por ahora, lo vemos"— y esta es la respuesta: no hace falta afinar nada para
 * arrancar.
 */
export const TARGET_INDUSTRIES = [
  'retail',
  'wholesale',
  'restaurants',
  'professional_services',
  'healthcare',
  'logistics',
  'construction',
  'manufacturing',
  'technology',
  'education',
  'beauty_wellness',
  'agriculture',
  'hospitality',
  'automotive',
  'real_estate',
  'events',
  'nonbank_financial',
  'nonprofit',
  'media',
  'apparel',
  'bakery',
  'veterinary',
  'security',
  'cleaning',
  'energy',
  'import_export',
  'marketing',
  'telecom',
] as const;

export type TargetIndustry = (typeof TARGET_INDUSTRIES)[number];

/**
 * ¿Este valor de `companies.industry` es una de las industrias que el producto reconoce?
 *
 * No se usa para RECHAZAR: `companies.industry` sigue siendo texto libre a propósito, porque un
 * cliente cuyo rubro no esté en la lista tiene que poder registrarse igual. Sirve para saber si
 * vale la pena buscarle una plantilla curada o ir directo a la genérica.
 */
export function esIndustriaObjetivo(industry: string): industry is TargetIndustry {
  return (TARGET_INDUSTRIES as readonly string[]).includes(industry);
}
