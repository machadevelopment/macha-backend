import { describe, expect, test } from 'bun:test';
import { planBatchSize, estimatedOutputTokensPerRow } from './sheet-batching';
import { intakeConfig } from '@/config/intake';

const row = (cells: number): unknown[] => Array.from({ length: cells }, (_, i) => `c${i}`);
const sheet = (rows: number, cells: number): unknown[][] =>
  Array.from({ length: rows }, () => row(cells));

/**
 * CU-868kmwdqu. El caso que originó todo: la hoja `Ventas` del primer Excel real de
 * producción — 521 filas × 16 columnas — pasaba el cap por filas (521 < 5.000) y por
 * eso iba entera en UNA llamada, cuya salida no cabía en `max_tokens`. El modelo
 * cortaba, el JSON llegaba partido y el documento entero se perdía.
 */
describe('planBatchSize (CU-868kmwdqu)', () => {
  test('el lote de 305 filas que volvió a romper producción ya no se planifica', () => {
    // Segunda corrida, 2026-08-05: con la calibración vieja el planificador mandó 305
    // filas de `Ventas` en una llamada y la respuesta se cortó otra vez. El número está
    // acá con nombre y apellido para que una recalibración futura no lo reintroduzca.
    expect(planBatchSize(sheet(521, 16))).toBeLessThan(305);
  });

  test('el presupuesto se calibra sobre el peor caso medido, no sobre el promedio', () => {
    // Producción midió hasta ~294 tokens de salida por fila en lotes grandes. Un lote
    // planificado no debe superar el presupuesto ni con ese costo por fila.
    const PEOR_CASO_MEDIDO = 294;
    for (const cols of [6, 9, 13, 16, 17]) {
      const filas = planBatchSize(sheet(600, cols));
      expect(filas * PEOR_CASO_MEDIDO).toBeLessThanOrEqual(intakeConfig.outputTokenBudget);
    }
  });

  test('la hoja que rompió producción ya no va en una sola llamada', () => {
    const ventas = sheet(521, 16);
    const size = planBatchSize(ventas);
    expect(size).toBeLessThan(521);
    // Y lo que se manda cabe en el presupuesto, que es el punto.
    expect(size * estimatedOutputTokensPerRow(ventas)).toBeLessThanOrEqual(
      intakeConfig.outputTokenBudget,
    );
  });

  test('manda el ancho, no solo el largo: misma cantidad de filas, lotes distintos', () => {
    // Contar solo filas es exactamente lo que ignoraba la variable que hace explotar
    // el presupuesto. Con el mismo número de filas, la hoja ancha tiene que partirse
    // más que la angosta.
    const anchas = planBatchSize(sheet(500, 24));
    const angostas = planBatchSize(sheet(500, 3));
    expect(anchas).toBeLessThan(angostas);
  });

  test('una hoja chica sigue yendo en una sola llamada', () => {
    // No se trata de partir por partir: 7 filas angostas caben de sobra y partirlas
    // multiplicaría el costo en Anthropic sin motivo.
    expect(planBatchSize(sheet(7, 9))).toBe(7);
  });

  test('el cap por filas de CU-868kfv972 sigue siendo el techo', () => {
    // Hoja enorme pero angosta: el presupuesto de tokens permitiría más filas que el
    // cap aprobado por Jose, y aun así manda el cap.
    const size = planBatchSize(sheet(20_000, 1));
    expect(size).toBeLessThanOrEqual(intakeConfig.batchSize);
  });

  test('una fila absurdamente ancha se intenta igual, nunca da lote 0', () => {
    // Un lote de 0 filas no avanzaría nunca. Si ni una fila cabe, que falle la llamada
    // con SheetOutputTruncatedError, que sí dice qué hacer.
    expect(planBatchSize(sheet(3, 5_000))).toBe(1);
  });

  test('una fila anómalamente ancha no encoge los lotes de toda la hoja', () => {
    // Caso real de Exceles de pyme: un título desparramado o una fila de totales mucho
    // más ancha que el resto. Tomando el máximo, esa sola fila dictaría el tamaño de
    // todos los lotes; por eso se usa un percentil alto.
    const normal = sheet(200, 6);
    const conFilaRara = [...sheet(200, 6), row(400)];
    expect(planBatchSize(conFilaRara)).toBeGreaterThan(planBatchSize(normal) / 2);
  });

  test('hoja vacía no produce lotes', () => {
    expect(planBatchSize([])).toBe(0);
  });
});
