import { unzipSync, strFromU8 } from 'fflate';

/** Parses an Excel dimension ref ("A1:F123" or a single cell "A1") into a row count. */
function rowsFromDimensionRef(ref: string): number {
  const range = ref.match(/^[A-Z]+(\d+):[A-Z]+(\d+)$/);
  if (range) return Math.max(0, Number(range[2]) - Number(range[1]) + 1);
  const single = ref.match(/^[A-Z]+(\d+)$/);
  return single ? 1 : 0;
}

/**
 * Cheaply inspects an .xlsx file's sheet count and per-sheet row count WITHOUT
 * materializing any cell data — reads the `<dimension ref="..."/>` attribute straight
 * from each sheet's XML inside the zip container. CU-868kfv972 (Jose): "parsear el
 * libro completo para contar ya es procesar" — this is the cheap pre-check that
 * enforces intake caps at receipt, before the worker (CU-868kfva8v) does the real
 * parse. Order is not workbook tab order (that requires resolving _rels), which
 * doesn't matter for cap enforcement — every sheet is counted regardless of order.
 *
 * Only applies to .xlsx (an OOXML zip). .xls (legacy binary) and .csv don't have this
 * structure — callers fall back to size-based caps for those formats.
 */
export function inspectXlsxWorkbook(buffer: Uint8Array): { sheetRowCounts: number[] } {
  const zip = unzipSync(buffer, {
    filter: (file) => /^xl\/worksheets\/sheet\d+\.xml$/.test(file.name),
  });

  const sheetRowCounts = Object.keys(zip)
    .sort((a, b) => {
      const na = Number(a.match(/sheet(\d+)\.xml/)?.[1] ?? 0);
      const nb = Number(b.match(/sheet(\d+)\.xml/)?.[1] ?? 0);
      return na - nb;
    })
    .map((name) => {
      const xml = strFromU8(zip[name]!);
      const ref = xml.match(/<dimension ref="([^"]+)"/)?.[1];
      return ref ? rowsFromDimensionRef(ref) : 0;
    });

  return { sheetRowCounts };
}

/**
 * Estimate how many Claude calls (batches) the worker (CU-868kfva8v) will make for
 * these sheets — used at intake time (CU-868kfvaa6) to hard-block on insufficient
 * credits BEFORE enqueueing, since the `excel` credit rule is billed per batch. A
 * sheet at/under the threshold is one call; larger sheets split into `batchSize`
 * chunks. Approximate: the worker's real chunking may differ slightly once
 * `sheet_to_json` filters blank rows the dimension ref doesn't know about.
 */
export function estimateBatchCount(
  sheetRowCounts: number[],
  largeSheetRowThreshold: number,
  batchSize: number,
): number {
  return sheetRowCounts.reduce((total, rows) => {
    if (rows === 0) return total;
    return total + (rows > largeSheetRowThreshold ? Math.ceil(rows / batchSize) : 1);
  }, 0);
}
