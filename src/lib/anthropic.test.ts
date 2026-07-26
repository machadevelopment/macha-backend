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

describe('estimateCostUsd', () => {
  test('computes cost from input/output tokens at the configured per-MTok rate', () => {
    // 1,000,000 input + 1,000,000 output tokens at the current intro rate ($2/$10).
    expect(estimateCostUsd(1_000_000, 1_000_000)).toBeCloseTo(12, 6);
  });

  test('zero tokens costs zero', () => {
    expect(estimateCostUsd(0, 0)).toBe(0);
  });
});
