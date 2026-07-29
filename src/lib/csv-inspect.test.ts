import { describe, expect, test } from 'bun:test';
import { countCsvRows } from './csv-inspect';

const csv = (text: string) => new TextEncoder().encode(text);

describe('countCsvRows (CU-868kh8man)', () => {
  test('cuenta filas separadas por LF', () => {
    expect(countCsvRows(csv('a,b\n1,2\n3,4\n'))).toBe(3);
  });

  test('cuenta el último registro aunque no termine en salto de línea', () => {
    expect(countCsvRows(csv('a,b\n1,2'))).toBe(2);
  });

  test('no cuenta una línea final vacía', () => {
    expect(countCsvRows(csv('a,b\n1,2\n'))).toBe(2);
  });

  test('CRLF cuenta una sola vez, no dos', () => {
    expect(countCsvRows(csv('a,b\r\n1,2\r\n'))).toBe(2);
  });

  test('CR solo (Mac clásico) separa registros', () => {
    expect(countCsvRows(csv('a,b\r1,2\r'))).toBe(2);
  });

  test('archivo vacío es 0 filas', () => {
    expect(countCsvRows(csv(''))).toBe(0);
  });

  // El caso que motiva el escaneo con comillas en vez de contar '\n' a secas: una pyme
  // manda descripciones multilínea y un conteo ingenuo inflaría el total, rechazando
  // archivos legítimos por "demasiadas filas".
  test('un salto de línea DENTRO de un campo entrecomillado no separa registros', () => {
    expect(countCsvRows(csv('desc,monto\n"linea uno\nlinea dos",100\n'))).toBe(2);
  });

  test('varios saltos dentro de comillas siguen siendo un solo registro', () => {
    expect(countCsvRows(csv('"a\nb\nc\nd",1\n"x",2\n'))).toBe(2);
  });

  test('comilla escapada ("") no cierra el campo antes de tiempo', () => {
    expect(countCsvRows(csv('"dijo ""hola""\ny se fue",1\n'))).toBe(1);
  });

  test('CRLF dentro de comillas tampoco separa', () => {
    expect(countCsvRows(csv('"linea uno\r\nlinea dos",100\r\n'))).toBe(1);
  });
});

describe('countCsvRows — el caso que originó el ticket', () => {
  test('un CSV con más filas que el cap se puede detectar sin materializar filas', () => {
    // 60k filas > INTAKE_MAX_ROWS_PER_FILE (50k) pero muy por debajo del cap de 10 MB:
    // exactamente el archivo que antes entraba entero porque solo se miraba el tamaño.
    const rows = 60_000;
    const buffer = csv('a,b\n'.repeat(rows));
    expect(countCsvRows(buffer)).toBe(rows);
    expect(buffer.byteLength).toBeLessThan(10 * 1024 * 1024);
  });
});
