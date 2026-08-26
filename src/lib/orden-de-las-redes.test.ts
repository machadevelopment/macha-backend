import { describe, expect, test } from 'bun:test';
import { WATCHDOG_MS, IDLE_TX_TIMEOUT_MS, MATAR_COLGADAS_SEG } from './orden-de-las-redes';

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * EL ORDEN DE LAS TRES REDES DEL POOL (crash en bucle del 2026-08-26)
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *
 * Las tres redes nacieron el mismo día en tres commits distintos y quedaron en el orden
 * INVERSO al que necesitan: Postgres mataba la sesión a los 60 s y el watchdog le escribía
 * `rollback` a los 90 s. Escribirle a un backend terminado mata el proceso —`socket.write`
 * sobre null, dentro de un `setImmediate` de postgres.js, fuera de toda promesa—, así que
 * producción entró en bucle de crash y ninguna carga de Excel podía terminar.
 *
 * Cada valor por separado era defendible. Lo que estaba mal era la RELACIÓN entre ellos, y
 * ninguno de los tres archivos podía verla porque cada uno tenía su constante. Por eso ahora
 * viven juntos y por eso este test existe: es la única forma de que el invariante tenga dueño.
 */
describe('orden de las redes del pool', () => {
  /*
   * EL INVARIANTE. Las dos comparaciones son la misma idea dicha dos veces: la red que
   * ESCRIBE va antes que las que MATAN, porque después de una muerte no se puede escribir.
   */
  test('la red que escribe va PRIMERO y las que matan van después', () => {
    expect(WATCHDOG_MS).toBeLessThan(IDLE_TX_TIMEOUT_MS);
    expect(IDLE_TX_TIMEOUT_MS).toBeLessThan(MATAR_COLGADAS_SEG * 1000);
  });

  /*
   * Un margen de verdad, no un empate técnico. Con las tres pegadas, una request que tarda un
   * instante de más entre el rollback del watchdog y el hachazo de Postgres vuelve a caer en
   * la carrera que este arreglo vino a cerrar. 30 s es el margen que ya existía entre las
   * redes originales, conservado hacia el lado correcto.
   */
  test('hay al menos 30 s entre una red y la siguiente', () => {
    expect(IDLE_TX_TIMEOUT_MS - WATCHDOG_MS).toBeGreaterThanOrEqual(30_000);
    expect(MATAR_COLGADAS_SEG * 1000 - IDLE_TX_TIMEOUT_MS).toBeGreaterThanOrEqual(30_000);
  });

  /*
   * El watchdog no se toca al reordenar, y esto lo fija. Bajarlo también ordenaría las redes
   * —y era la opción tentadora, un solo número— pero el watchdog es el único que DESHACE
   * trabajo: adelantarlo aumenta la probabilidad de revertir una transacción legítima que solo
   * iba lenta. La tolerancia de una request tiene que quedar donde estaba.
   */
  test('el watchdog conserva su tolerancia de 90 s', () => {
    expect(WATCHDOG_MS).toBe(90_000);
  });
});
