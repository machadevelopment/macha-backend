import { describe, expect, test } from 'bun:test';
import { buildIndustryTemplateBlock } from './industry-template';

describe('buildIndustryTemplateBlock', () => {
  test('marks the block as ephemeral cache_control (CU-868kfva91)', () => {
    const block = buildIndustryTemplateBlock({
      synonyms: { 'revenue.sales': ['venta', 'ventas'] },
      fewShot: [{ input: 'Venta de mostrador, Q100', output: { type: 'revenue' } }],
    });
    expect(block.cache_control).toEqual({ type: 'ephemeral' });
  });

  test('serializes synonyms and few-shot examples into the text block', () => {
    const block = buildIndustryTemplateBlock({
      synonyms: { 'opex.rent': ['renta', 'alquiler'] },
      fewShot: [{ input: 'Pago de renta enero', output: { type: 'opex', category: 'rent' } }],
    });
    expect(block.type).toBe('text');
    expect(block.text).toContain('renta');
    expect(block.text).toContain('Pago de renta enero');
    expect(block.text).toContain('"opex"');
  });
});
