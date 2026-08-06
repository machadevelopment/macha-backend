import { describe, expect, test } from 'bun:test';
import { buildIndustryTemplateBlock, normalizeIndustry } from './industry-template';
import { DEFAULT_INDUSTRY_TEMPLATE } from '@/config/default-industry-template';

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

  test('presenta el diccionario como referencia abierta, no como lista cerrada', () => {
    // Regla de diseño (Keneth, 2026-08-06): el motor debe poder con cualquier archivo.
    // Si este bloque vuelve a presentarse como LA autoridad del mapeo, el modelo deja
    // de clasificar lo que no esté en el diccionario y regresa el problema original —
    // pero ahora en silencio, como filas marcadas, no como un error visible.
    const block = buildIndustryTemplateBlock({
      synonyms: { 'opex.rent': ['renta'] },
      fewShot: [],
    });
    expect(block.text).toContain('no es una lista cerrada');
    expect(block.text).toContain('tu propio criterio');
  });
});

describe('normalizeIndustry', () => {
  test('mayúsculas y espacios no crean industrias distintas', () => {
    // El caso real que rompió producción: la empresa se auto-registró como "TECH" y
    // la búsqueda de plantilla comparaba con `=` contra "tech".
    expect(normalizeIndustry('TECH')).toBe('tech');
    expect(normalizeIndustry('  Tech  ')).toBe('tech');
    expect(normalizeIndustry('Retail')).toBe(normalizeIndustry('RETAIL'));
  });

  test('no altera una industria que ya está en forma canónica', () => {
    expect(normalizeIndustry('retail')).toBe('retail');
  });
});

describe('DEFAULT_INDUSTRY_TEMPLATE', () => {
  // El fallback se manda a Claude tal cual, sin pasar por la base ni por validación de
  // TypeBox. Si su forma se desalinea del esquema de salida (lib/anthropic.ts), el
  // few-shot le enseña al modelo a responder algo que el parseo rechaza — y solo se
  // notaría con un documento real fallando en producción.
  test('todas las claves de sinónimos usan la taxonomía fija tipo.categoría', () => {
    const tipos = ['revenue', 'cogs', 'opex', 'other'];
    for (const key of Object.keys(DEFAULT_INDUSTRY_TEMPLATE.synonyms)) {
      const [tipo, categoria] = key.split('.');
      expect(tipos).toContain(tipo ?? '');
      expect(categoria).toBeTruthy();
    }
  });

  test('ninguna lista de sinónimos está vacía', () => {
    for (const [key, terms] of Object.entries(DEFAULT_INDUSTRY_TEMPLATE.synonyms)) {
      expect(terms.length, `sinónimos vacíos en ${key}`).toBeGreaterThan(0);
    }
  });

  test('los ejemplos few-shot tienen la forma que el esquema de salida exige', () => {
    expect(DEFAULT_INDUSTRY_TEMPLATE.fewShot.length).toBeGreaterThan(0);
    for (const example of DEFAULT_INDUSTRY_TEMPLATE.fewShot) {
      expect(example.input).toBeTruthy();
      const output = example.output as {
        targetEntity: string;
        confidence: number;
        payload: { originalCurrency: string };
      };
      expect(['transaction', 'invoice', 'bill']).toContain(output.targetEntity);
      expect(output.confidence).toBeGreaterThan(0);
      expect(output.confidence).toBeLessThanOrEqual(1);
      expect(output.payload).toBeTruthy();
      expect(['GTQ', 'USD']).toContain(output.payload.originalCurrency);
    }
  });

  test('los montos de los ejemplos son positivos aunque el input traiga signo negativo', () => {
    // El esquema no tiene signo: el tipo (revenue/cogs/opex) es lo que da la dirección.
    // Un few-shot con -18000 le enseñaría al modelo a duplicar esa señal.
    for (const example of DEFAULT_INDUSTRY_TEMPLATE.fewShot) {
      const payload = (example.output as { payload: { originalAmount: number } }).payload;
      expect(payload.originalAmount).toBeGreaterThan(0);
    }
  });

  test('cubre categorías de servicios/software que retail no tiene', () => {
    // La razón de existir del fallback: la empresa que lo dispara no es retail.
    const keys = Object.keys(DEFAULT_INDUSTRY_TEMPLATE.synonyms);
    expect(keys).toContain('revenue.services');
    expect(keys).toContain('revenue.subscriptions');
    expect(keys).toContain('opex.software');
  });
});
