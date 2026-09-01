import { describe, expect, test } from 'bun:test';
import { mapaDeDineroProbable } from './sheet-money';

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * CUÁNTO DINERO TRAÍA UNA HOJA QUE NUNCA LLEGÓ AL MODELO
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *
 * `mapaDeDineroProbable` estima por encabezados y magnitudes: es lo que permite decir "descarté
 * Q 2.707.318" en vez de "descarté 220 filas", que es la diferencia entre un resumen que el
 * dueño puede desmentir y uno que no le dice nada.
 *
 * ⚠️ Y desde el PORTÓN (migración 0042) esta cifra se le MUESTRA al cliente en el momento en
 * que decide si publica su contabilidad. Dejó de ser una estimación interna.
 */
describe('un identificador no es dinero, y con el portón el cliente lo VE', () => {
  /*
   * Medido en producción el 2026-09-01: la hoja `Clientes_B2B` descartada declaraba
   * **GTQ 306.000.081,00** en la pantalla de confirmación — la suma de su columna de
   * TELÉFONOS. Antes del portón esta estimación solo explicaba y ranqueaba; ahora se le
   * muestra al dueño en el momento en que decide si publica su contabilidad, y un cliente que
   * lee 306 millones deja de creerle a la pantalla entera.
   */
  const cartera = [
    ['Cliente', 'NIT', 'Telefono', 'Venta neta acumulada'],
    ['Cliente 1', '100001-K', 51_000_011, 12_430],
    ['Cliente 2', '100002-K', 51_000_012, 12_860],
    ['Cliente 3', '100003-K', 51_000_013, 13_290],
    ['Cliente 4', '100004-K', 51_000_014, 13_720],
  ]; // prettier-ignore

  test('elige la columna de dinero, no la de teléfonos', () => {
    const mapa = mapaDeDineroProbable(cartera);
    // La columna 3 (`Venta neta acumulada`), no la 2. Sin el veto ganaba el teléfono por
    // magnitud: 51 millones contra 12 mil.
    expect(mapa.amount).toBe(3);
  });

  test('⚠️ el veto es por VOCABULARIO, no por magnitud', () => {
    /*
     * Un teléfono de 8 dígitos y la factura de una constructora son indistinguibles por el
     * número. Poner un techo recortaría el monto legítimo; lo que sí los separa es cómo se
     * llama la columna — nadie titula "Teléfono" a una de dinero.
     */
    const constructora = [
      ['Fecha', 'Cliente', 'Monto'],
      ['2026-01-10', 'Obra 1', 51_000_011],
      ['2026-02-10', 'Obra 2', 48_500_000],
      ['2026-03-10', 'Obra 3', 52_100_000],
    ]; // prettier-ignore
    expect(mapaDeDineroProbable(constructora).amount).toBe(2);
  });
});
