import { describe, expect, test } from 'bun:test';

// env.ts validates DATABASE_URL at import time even for modules (like this one) that
// never touch the DB — same stub pattern as modules/health/index.test.ts.
process.env.DATABASE_URL ??= 'postgres://smoke:smoke@localhost:5432/smoke';

const { assertZdrModel, estimateCostUsd } = await import('./anthropic');

describe('assertZdrModel', () => {
  test('accepts the ZDR-verified model', () => {
    expect(() => assertZdrModel('claude-sonnet-5')).not.toThrow();
  });

  test('rejects any other model', () => {
    expect(() => assertZdrModel('claude-opus-5')).toThrow();
    expect(() => assertZdrModel('gpt-4')).toThrow();
  });
});

describe('anthropicModel resuelve desde configuración, nunca hardcodeado (CU-868kfvazj)', () => {
  test('ANTHROPIC_MODEL en env determina el modelo sin tocar código', async () => {
    const prevValue = process.env.ANTHROPIC_MODEL;
    try {
      process.env.ANTHROPIC_MODEL = 'claude-sonnet-5';
      // Cache-bust: env.ts ya fue importado arriba con el valor por defecto: un
      // import normal reusaría ese módulo cacheado en vez de releerlo con el env
      // recién seteado.
      const { env: freshEnv } = await import(`./env?cb=${crypto.randomUUID()}`);
      expect(freshEnv.anthropicModel).toBe('claude-sonnet-5');
    } finally {
      if (prevValue === undefined) delete process.env.ANTHROPIC_MODEL;
      else process.env.ANTHROPIC_MODEL = prevValue;
    }
  });

  test('un modelo no verificado para ZDR sigue rechazado aunque venga de config', async () => {
    const prevValue = process.env.ANTHROPIC_MODEL;
    try {
      process.env.ANTHROPIC_MODEL = 'claude-opus-5';
      const { env: freshEnv } = await import(`./env?cb=${crypto.randomUUID()}`);
      expect(() => assertZdrModel(freshEnv.anthropicModel)).toThrow();
    } finally {
      if (prevValue === undefined) delete process.env.ANTHROPIC_MODEL;
      else process.env.ANTHROPIC_MODEL = prevValue;
    }
  });
});

describe('estimateCostUsd', () => {
  test('computes cost from input/output tokens at the configured per-MTok rate', () => {
    // 1,000,000 input + 1,000,000 output tokens at the current intro rate ($2/$10).
    expect(estimateCostUsd(1_000_000, 1_000_000)).toBeCloseTo(12, 6);
  });

  test('zero tokens costs zero', () => {
    expect(estimateCostUsd(0, 0)).toBe(0);
  });
});
