import { describe, expect, test } from 'bun:test';
import { zipSync, strToU8 } from 'fflate';
import { inspectXlsxWorkbook, estimateBatchCount } from './xlsx-inspect';

function fakeXlsx(sheetDimensions: string[]): Uint8Array {
  const files: Record<string, Uint8Array> = {};
  sheetDimensions.forEach((ref, i) => {
    files[`xl/worksheets/sheet${i + 1}.xml`] = strToU8(
      `<?xml version="1.0"?><worksheet><dimension ref="${ref}"/><sheetData/></worksheet>`,
    );
  });
  return zipSync(files);
}

describe('inspectXlsxWorkbook', () => {
  test('reads row counts from the dimension ref without touching sheetData', () => {
    const buf = fakeXlsx(['A1:C10', 'A1:Z5000']);
    expect(inspectXlsxWorkbook(buf).sheetRowCounts).toEqual([10, 5000]);
  });

  test('a single-cell dimension counts as 1 row', () => {
    const buf = fakeXlsx(['A1']);
    expect(inspectXlsxWorkbook(buf).sheetRowCounts).toEqual([1]);
  });

  test('counts sheets in numeric order regardless of zip entry order', () => {
    const files: Record<string, Uint8Array> = {
      'xl/worksheets/sheet2.xml': strToU8('<worksheet><dimension ref="A1:A2"/></worksheet>'),
      'xl/worksheets/sheet1.xml': strToU8('<worksheet><dimension ref="A1:A99"/></worksheet>'),
    };
    const buf = zipSync(files);
    expect(inspectXlsxWorkbook(buf).sheetRowCounts).toEqual([99, 2]);
  });
});

describe('estimateBatchCount', () => {
  test('a sheet at/under the threshold is a single batch', () => {
    expect(estimateBatchCount([100, 5000], 5000, 2000)).toBe(2);
  });

  test('a sheet over the threshold splits into ceil(rows/batchSize) batches', () => {
    expect(estimateBatchCount([5001], 5000, 2000)).toBe(3); // ceil(5001/2000) = 3
  });

  test('empty sheets contribute zero batches', () => {
    expect(estimateBatchCount([0, 100, 0], 5000, 2000)).toBe(1);
  });

  test('mixes small and large sheets correctly', () => {
    expect(estimateBatchCount([100, 12000], 5000, 2000)).toBe(1 + 6); // ceil(12000/2000)=6
  });
});
