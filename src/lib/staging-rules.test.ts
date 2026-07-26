import { describe, expect, test } from 'bun:test';
import { evaluateFlagReason, CONFIDENCE_THRESHOLD, type MappedRow } from './staging-rules';

const cleanTransaction: MappedRow = {
  targetEntity: 'transaction',
  confidence: 0.95,
  payload: {
    type: 'revenue',
    category: 'sales',
    date: '2026-01-15',
    originalAmount: 1500,
    originalCurrency: 'GTQ',
  },
};

const cleanInvoice: MappedRow = {
  targetEntity: 'invoice',
  confidence: 0.9,
  payload: {
    counterparty: 'Ferretería Los Pinos',
    issueDate: '2026-01-05',
    originalAmount: 3200,
    originalCurrency: 'GTQ',
  },
};

describe('evaluateFlagReason — confidence', () => {
  test('flags rows below the confidence threshold regardless of otherwise-clean data', () => {
    const row = { ...cleanTransaction, confidence: CONFIDENCE_THRESHOLD - 0.01 };
    expect(evaluateFlagReason(row)).toBe(`low_confidence:${row.confidence.toFixed(2)}`);
  });

  test('does not flag a clean transaction at/above the threshold', () => {
    expect(
      evaluateFlagReason({ ...cleanTransaction, confidence: CONFIDENCE_THRESHOLD }),
    ).toBeNull();
    expect(evaluateFlagReason(cleanTransaction)).toBeNull();
  });
});

describe('evaluateFlagReason — transaction rules', () => {
  test('flags an invalid type', () => {
    const row = { ...cleanTransaction, payload: { ...cleanTransaction.payload, type: 'income' } };
    expect(evaluateFlagReason(row)).toBe('invalid_type');
  });

  test('flags a missing category', () => {
    const row = { ...cleanTransaction, payload: { ...cleanTransaction.payload, category: '' } };
    expect(evaluateFlagReason(row)).toBe('missing_category');
  });

  test('flags an unparseable date', () => {
    const row = {
      ...cleanTransaction,
      payload: { ...cleanTransaction.payload, date: 'not-a-date' },
    };
    expect(evaluateFlagReason(row)).toBe('invalid_date');
  });

  test('flags a zero amount', () => {
    const row = {
      ...cleanTransaction,
      payload: { ...cleanTransaction.payload, originalAmount: 0 },
    };
    expect(evaluateFlagReason(row)).toBe('invalid_amount');
  });

  test('flags an unrecognized currency', () => {
    const row = {
      ...cleanTransaction,
      payload: { ...cleanTransaction.payload, originalCurrency: 'EUR' },
    };
    expect(evaluateFlagReason(row)).toBe('invalid_currency');
  });

  test('a negative amount is valid (cogs/opex can be recorded as negative)', () => {
    const row = {
      ...cleanTransaction,
      payload: { ...cleanTransaction.payload, originalAmount: -500 },
    };
    expect(evaluateFlagReason(row)).toBeNull();
  });
});

describe('evaluateFlagReason — invoice/bill rules', () => {
  test('does not flag a clean invoice', () => {
    expect(evaluateFlagReason(cleanInvoice)).toBeNull();
  });

  test('flags a missing counterparty', () => {
    const row = { ...cleanInvoice, payload: { ...cleanInvoice.payload, counterparty: '  ' } };
    expect(evaluateFlagReason(row)).toBe('missing_counterparty');
  });

  test('flags a negative or zero amount', () => {
    const row = { ...cleanInvoice, payload: { ...cleanInvoice.payload, originalAmount: -1 } };
    expect(evaluateFlagReason(row)).toBe('invalid_amount');
  });

  test('bill uses the same shape as invoice', () => {
    const row: MappedRow = { ...cleanInvoice, targetEntity: 'bill' };
    expect(evaluateFlagReason(row)).toBeNull();
  });
});
