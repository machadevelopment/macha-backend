import type { DB } from '@/db/client';
import { stagingRows } from '@/db/schema';
import { evaluateFlagReason, type MappedRow } from './staging-rules';

/**
 * Inserts extracted rows into staging_rows, applying the flag rules (CU-868kfva9q):
 * by validation rules and by model confidence. Called by the worker (CU-868kfva8v)
 * after each Claude call for a sheet/batch — one INSERT per batch, not per row.
 */
export async function insertStagingRows(
  db: DB,
  companyId: string,
  documentId: string,
  rows: MappedRow[],
): Promise<void> {
  if (rows.length === 0) return;

  await db.insert(stagingRows).values(
    rows.map((row) => {
      const flagReason = evaluateFlagReason(row);
      return {
        companyId,
        documentId,
        targetEntity: row.targetEntity,
        payload: row.payload,
        confidence: row.confidence.toFixed(4),
        flagReason,
        reviewStatus: flagReason ? ('pending' as const) : ('clean' as const),
      };
    }),
  );
}
