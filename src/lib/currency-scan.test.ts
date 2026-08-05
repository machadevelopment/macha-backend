import { describe, expect, test } from 'bun:test';
import { zipSync, strToU8 } from 'fflate';
import { fileMentionsCurrency, isScannable } from '@/lib/currency-scan';

/**
 * CU-868kjc6h1 criterio 2. Lo que se prueba aquí es el LÍMITE de la heurística tanto
 * como su acierto: es la señal que decide si un upload se rechaza en la recepción, así
 * que importa igual que no dispare de más ("USDT" no es "USD") y que no lance con basura.
 */

function xlsx(parts: Record<string, string>): Uint8Array {
  const entries: Record<string, Uint8Array> = {};
  for (const [name, xml] of Object.entries(parts)) entries[name] = strToU8(xml);
  return zipSync(entries);
}

describe('fileMentionsCurrency (CU-868kjc6h1)', () => {
  test('csv: encuentra el código como palabra', () => {
    const csv = strToU8('fecha,monto,moneda\n2026-01-05,120.50,USD\n');
    expect(fileMentionsCurrency(csv, 'csv', 'USD')).toBe(true);
    expect(fileMentionsCurrency(csv, 'csv', 'GTQ')).toBe(false);
  });

  test('csv: no confunde un código embebido en otra palabra', () => {
    const csv = strToU8('fecha,monto,moneda\n2026-01-05,120.50,USDT\n');
    expect(fileMentionsCurrency(csv, 'csv', 'USD')).toBe(false);
  });

  test('xlsx: mira las cadenas compartidas', () => {
    const book = xlsx({
      'xl/sharedStrings.xml': '<sst><si><t>Moneda</t></si><si><t>USD</t></si></sst>',
      'xl/worksheets/sheet1.xml': '<worksheet><dimension ref="A1:C2"/></worksheet>',
    });
    expect(fileMentionsCurrency(book, 'xlsx', 'USD')).toBe(true);
    expect(fileMentionsCurrency(book, 'xlsx', 'GTQ')).toBe(false);
  });

  test('xlsx: también mira las cadenas en línea de la hoja', () => {
    const book = xlsx({
      'xl/worksheets/sheet1.xml': '<worksheet><c t="inlineStr"><is><t>GTQ</t></is></c></worksheet>',
    });
    expect(fileMentionsCurrency(book, 'xlsx', 'GTQ')).toBe(true);
  });

  test('un archivo ilegible no bloquea el upload: devuelve false en vez de lanzar', () => {
    const basura = new Uint8Array([0, 1, 2, 3, 4]);
    expect(fileMentionsCurrency(basura, 'xlsx', 'USD')).toBe(false);
  });

  test('solo xlsx y csv se pueden inspeccionar barato', () => {
    expect(isScannable('xlsx')).toBe(true);
    expect(isScannable('csv')).toBe(true);
    // `.xls` es binario legacy: sus filas en moneda extranjera las atrapa el marcado de
    // staging, no la recepción.
    expect(isScannable('xls')).toBe(false);
  });
});
