import { describe, expect, test } from 'bun:test';

process.env.DATABASE_URL ??= 'postgres://smoke:smoke@localhost:5432/smoke';

const { estimateRequiredCredits } = await import('./credits');

describe('estimateRequiredCredits (CU-868kfvaa6)', () => {
  test('regla fija: ignora unitCount, devuelve creditsPerUnit tal cual', () => {
    const rule = { ruleType: 'fixed' as const, creditsPerUnit: '10' };
    expect(estimateRequiredCredits(rule, 1)).toBe(10);
    expect(estimateRequiredCredits(rule, 999)).toBe(10);
  });

  test('regla variable: creditsPerUnit × unitCount', () => {
    const rule = { ruleType: 'variable' as const, creditsPerUnit: '2' };
    expect(estimateRequiredCredits(rule, 5)).toBe(10);
  });

  test('regla variable con creditsPerUnit fraccional (numeric column)', () => {
    const rule = { ruleType: 'variable' as const, creditsPerUnit: '0.5' };
    expect(estimateRequiredCredits(rule, 7)).toBe(3.5);
  });

  test('regla variable con unitCount 0 devuelve 0', () => {
    const rule = { ruleType: 'variable' as const, creditsPerUnit: '10' };
    expect(estimateRequiredCredits(rule, 0)).toBe(0);
  });
});
