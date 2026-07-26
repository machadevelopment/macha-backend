import type Anthropic from '@anthropic-ai/sdk';
import type { industryTemplateVersions } from '@/db/schema';

type TemplateVersionPayload = Pick<
  typeof industryTemplateVersions.$inferSelect,
  'synonyms' | 'fewShot'
>;

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
  const fewShotText = version.fewShot
    .map(
      (example, i) =>
        `Ejemplo ${i + 1}:\nEntrada: ${example.input}\nSalida esperada: ${JSON.stringify(example.output)}`,
    )
    .join('\n\n');

  return {
    type: 'text',
    text:
      'Diccionario de sinónimos por industria — mapea encabezados/descripciones de ' +
      `Excel a la taxonomía fija (type: revenue/cogs/opex/other):\n${JSON.stringify(version.synonyms, null, 2)}` +
      `\n\nEjemplos few-shot (clasificación de target_entity + mapeo de campos):\n${fewShotText}`,
    cache_control: { type: 'ephemeral' },
  };
}
