// CU-868kfva9q: marcado de staging_rows por reglas (validación determinista) y por
// confianza del modelo. Solo las filas marcadas van a revisión interna (US-17); las
// que no se marcan quedan `review_status='clean'`, listas para promoción (CU-868kfva9z).

const VALID_CURRENCIES = new Set(['GTQ', 'USD']);
const VALID_TYPES = new Set(['revenue', 'cogs', 'opex', 'other']);

/** Umbral de confianza del modelo por debajo del cual la fila se marca, sin importar
 * qué tan limpio se vea el resto de los campos. */
export const CONFIDENCE_THRESHOLD = 0.7;

export type MappedRow = {
  targetEntity: 'transaction' | 'invoice' | 'bill';
  payload: Record<string, unknown>;
  confidence: number;
};

function isValidDateString(value: unknown): value is string {
  if (typeof value !== 'string' || value.trim() === '') return false;
  return !Number.isNaN(new Date(value).getTime());
}

function isPositiveFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value !== 0;
}

/**
 * Returns the flag reason for a mapped row, or `null` if it's clean. Only one reason
 * is returned (the first rule that fails) — good enough for staff review triage;
 * the row itself (payload) is still available for a human to see everything wrong.
 */
export function evaluateFlagReason(row: MappedRow): string | null {
  if (row.confidence < CONFIDENCE_THRESHOLD) {
    return `low_confidence:${row.confidence.toFixed(2)}`;
  }

  if (row.targetEntity === 'transaction') {
    const p = row.payload as {
      type?: unknown;
      category?: unknown;
      date?: unknown;
      originalAmount?: unknown;
      originalCurrency?: unknown;
    };
    if (typeof p.type !== 'string' || !VALID_TYPES.has(p.type)) return 'invalid_type';
    if (typeof p.category !== 'string' || p.category.trim() === '') return 'missing_category';
    if (!isValidDateString(p.date)) return 'invalid_date';
    if (!isPositiveFiniteNumber(p.originalAmount)) return 'invalid_amount';
    if (typeof p.originalCurrency !== 'string' || !VALID_CURRENCIES.has(p.originalCurrency)) {
      return 'invalid_currency';
    }
    return null;
  }

  // invoice / bill share the same shape (AR/AP).
  const p = row.payload as {
    counterparty?: unknown;
    issueDate?: unknown;
    originalAmount?: unknown;
    originalCurrency?: unknown;
  };
  if (typeof p.counterparty !== 'string' || p.counterparty.trim() === '') {
    return 'missing_counterparty';
  }
  if (!isValidDateString(p.issueDate)) return 'invalid_issue_date';
  if (!isPositiveFiniteNumber(p.originalAmount) || (p.originalAmount as number) < 0) {
    return 'invalid_amount';
  }
  if (typeof p.originalCurrency !== 'string' || !VALID_CURRENCIES.has(p.originalCurrency)) {
    return 'invalid_currency';
  }
  return null;
}
