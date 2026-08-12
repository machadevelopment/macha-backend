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

  test('el presupuesto se calibra sobre el peor caso del esquema NUEVO', () => {
    // Los ~294 tokens por fila que se medían en producción eran del esquema viejo, cuando
    // el modelo devolvía la fila reconstruida. Hoy devuelve un objeto de forma fija
    // ({"i","e","t","c","cf"}): ~30 tokens, y ~40 con una categoría inusualmente larga.
    // El límite se verifica contra ESE número, no contra el histórico.
    const PEOR_CASO_ESQUEMA_NUEVO = 40;
    for (const cols of [6, 9, 13, 16, 17]) {
      const filas = planBatchSize(sheet(600, cols));
      expect(filas * PEOR_CASO_ESQUEMA_NUEVO).toBeLessThanOrEqual(intakeConfig.outputTokenBudget);
    }
  });

  test('el presupuesto acota la LATENCIA de cada llamada, no solo el corte', () => {
    /*
     * La razón por la que bajar el presupuesto era obligatorio y no opcional.
     *
     * El modelo genera token por token (~115 tok/s medido en producción), así que los
     * tokens de salida de un lote SON su tiempo de espera. Si al achicar el esquema se
     * hubiera dejado el presupuesto en 40.000, cada llamada seguiría generando 40.000
     * tokens y tardando los mismos ~165 s: el archivo saldría más barato y exactamente
     * igual de lento. Este test fija el techo de tiempo por llamada.
     */
    const TOKENS_POR_SEGUNDO = 115;
    const segundosPorLlamada = intakeConfig.outputTokenBudget / TOKENS_POR_SEGUNDO;
    expect(segundosPorLlamada).toBeLessThan(60);
  });

  test('el libro real entra en dos tandas: bajo los 3 minutos', () => {
    /*
     * La meta que puso Keneth (2026-08-12): menos de 3 minutos por archivo, contra los
     * ~50 que tardaba. Se cuenta sobre las hojas reales que SÍ llegan al modelo tras el
     * pre-filtro de catálogos (lib/sheet-classifier.ts).
     */
    const hojasQueVanAlModelo = { Ventas: [521, 16], LineasOC: [221, 6], OrdenesCompra: [61, 7] };

    const lotes = Object.values(hojasQueVanAlModelo).reduce((total, [filas, cols]) => {
      const hoja = sheet(filas!, cols!);
      return total + Math.ceil(filas! / planBatchSize(hoja));
    }, 0);

    const tandas = Math.ceil(lotes / intakeConfig.batchConcurrency);
    const segundosPorLlamada = intakeConfig.outputTokenBudget / 115;

    expect(tandas * segundosPorLlamada).toBeLessThan(180);
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

  test('el ancho DEJÓ de mandar, y es a propósito', () => {
    /*
     * Este test decía lo contrario hasta el 2026-08-12, y estaba bien mientras el modelo
     * devolvía la fila reconstruida: una fila de 24 columnas producía mucha más salida que
     * una de 3, así que la hoja ancha tenía que partirse más.
     *
     * Ya no. La respuesta por fila es de forma fija y no contiene ni un valor de la fila,
     * así que cuesta lo mismo en una hoja de 3 columnas que en una de 24. Seguir partiendo
     * las anchas sería multiplicar llamadas a Anthropic por una relación que ya no existe.
     *
     * Queda escrito como test, y no borrado, para que se lea como decisión y no como
     * descuido: si alguien vuelve a meter valores en la respuesta, este test tiene que
     * volver a invertirse junto con la calibración.
     */
    expect(planBatchSize(sheet(500, 24))).toBe(planBatchSize(sheet(500, 3)));
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

  test('nunca da lote 0', () => {
    // Un lote de 0 filas no avanzaría nunca. La garantía se conserva; lo que cambió es que
    // una fila absurdamente ancha ya no encoge el lote a 1, porque el ancho no cuesta
    // salida: 3 filas de 5.000 celdas caben las tres en una llamada.
    expect(planBatchSize(sheet(3, 5_000))).toBe(3);
    expect(planBatchSize(sheet(1, 5_000))).toBe(1);
  });

  test('una fila anómalamente ancha no encoge los lotes de toda la hoja', () => {
    // Caso real de Exceles de pyme: un título desparramado o una fila de totales mucho más
    // ancha que el resto. Antes se resolvía con un percentil sobre los anchos; ahora sale
    // gratis, porque el ancho ya no entra en la cuenta. La propiedad que le importa al
    // cliente es la misma, así que el test se queda.
    const normal = sheet(200, 6);
    const conFilaRara = [...sheet(200, 6), row(400)];
    expect(planBatchSize(conFilaRara)).toBeGreaterThanOrEqual(planBatchSize(normal));
  });

  test('hoja vacía no produce lotes', () => {
    expect(planBatchSize([])).toBe(0);
  });
});
