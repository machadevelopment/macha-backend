import { describe, expect, test } from 'bun:test';

process.env.DATABASE_URL ??= 'postgres://smoke:smoke@localhost:5432/smoke';

const { indexarVeredictos, hayDesplazamiento } = await import('./anthropic');

/**
 * ═══ LA GARANTÍA QUE ESTOS TESTS FIJAN ═══
 *
 * Ninguna fila del cliente desaparece sin que alguien se entere.
 *
 * Hasta el 2026-08-12 el código armaba lo que el modelo devolviera y no comparaba contra lo
 * que había mandado. Si de un lote de 88 filas volvían 60, las otras 28 simplemente no
 * existían: no fallaba nada, no se registraba nada, y esas filas nunca llegaban a la
 * contabilidad del cliente.
 *
 * Que eso pasa está MEDIDO, no supuesto: una corrida sobre el archivo real devolvió 772 de
 * 800 filas y la siguiente, sobre el mismo archivo, devolvió las 800. Intermitente — o sea
 * irreproducible, o sea imposible de encontrar por reporte de usuario.
 */

type V = {
  i: number;
  e: 'transaction' | 'invoice' | 'bill' | 'skip';
  t: null;
  c: null;
  cf: number;
};
const v = (i: number, e: V['e'] = 'transaction'): V => ({ i, e, t: null, c: null, cf: 0.9 });

describe('indexar veredictos', () => {
  test('un índice fuera de rango no se cuela como fila', () => {
    // Ocurre de verdad: en tres sondas reales del 2026-08-12, dos devolvieron un veredicto
    // extra apuntando a la posición N de un lote de N filas (índices válidos 0..N-1).
    const { porIndice, fueraDeRango } = indexarVeredictos([v(0), v(1), v(2)], 2);
    expect(porIndice.size).toBe(2);
    expect(fueraDeRango).toBe(1);
  });

  test('un índice repetido no duplica la fila', () => {
    // Sin esto, la misma venta entraría dos veces a la contabilidad del cliente. Gana el
    // primero: es estable entre corridas, y "el último" no tendría mejor argumento.
    const { porIndice } = indexarVeredictos([v(0), v(0), v(1)], 2);
    expect(porIndice.size).toBe(2);
  });

  test('un índice no entero se descarta en vez de romper el arreglo', () => {
    const { porIndice, fueraDeRango } = indexarVeredictos([{ ...v(0), i: 1.5 }, v(1)], 3);
    expect(porIndice.has(1)).toBe(true);
    expect(fueraDeRango).toBe(1);
  });
});

describe('desplazamiento de índices — el fallo que corrompe en silencio', () => {
  test('numerar desde 1 se detecta', () => {
    /*
     * Si el modelo devolviera 1..N para un lote de N filas y esto no lo detectara, pasarían
     * DOS cosas a la vez y ninguna dejaría rastro: se descartaría el índice N por fuera de
     * rango, y el veredicto de cada fila se aplicaría a la fila ANTERIOR.
     *
     * La contabilidad del lote entero quedaría corrida una posición, con montos y fechas
     * perfectamente creíbles. Es el peor modo de fallo que puede tener este producto.
     */
    const lote = 5;
    const veredictos = [1, 2, 3, 4, 5].map((i) => v(i));
    expect(hayDesplazamiento(veredictos, lote)).toBe(true);
  });

  test('saltarse la primera fila NO es desplazamiento', () => {
    // La distinción que evita el falso positivo. Un modelo que ignoró la fila 0 (la creyó un
    // encabezado repetido) devuelve 1..N-1 y NO devuelve N. Eso es una fila sin cubrir —se
    // reintenta y si hace falta va a revisión— no una corrupción del lote entero.
    const lote = 5;
    const veredictos = [1, 2, 3, 4].map((i) => v(i));
    expect(hayDesplazamiento(veredictos, lote)).toBe(false);
  });

  test('una respuesta correcta nunca lo dispara', () => {
    expect(
      hayDesplazamiento(
        [0, 1, 2, 3, 4].map((i) => v(i)),
        5,
      ),
    ).toBe(false);
  });

  test('un hueco en el medio no lo dispara', () => {
    // Falta el 3, pero está el 0: no hay corrimiento, hay una fila sin cubrir.
    expect(
      hayDesplazamiento(
        [0, 1, 2, 4, 5].map((i) => v(i)),
        5,
      ),
    ).toBe(false);
  });

  test('un lote de una sola fila nunca lo dispara', () => {
    // Con una fila, "devolvió el índice 1 y no el 0" es indistinguible de un error trivial y
    // no hay nada que corromper. Marcarlo sería ruido.
    expect(hayDesplazamiento([v(1)], 1)).toBe(false);
  });
});

describe('cobertura: qué filas quedaron sin veredicto', () => {
  const faltantes = (veredictos: V[], total: number): number[] => {
    const { porIndice } = indexarVeredictos(veredictos, total);
    return Array.from({ length: total }, (_, i) => i).filter((i) => !porIndice.has(i));
  };

  test('una respuesta completa no deja faltantes', () => {
    expect(
      faltantes(
        [0, 1, 2].map((i) => v(i)),
        3,
      ),
    ).toEqual([]);
  });

  test('las filas que el modelo NO devolvió se identifican una por una', () => {
    // Es la resta que el código siempre pudo hacer y no hacía.
    expect(faltantes([v(0), v(3)], 5)).toEqual([1, 2, 4]);
  });

  test('una fila marcada `skip` SÍ cuenta como cubierta', () => {
    /*
     * La distinción entera del cambio. `skip` es el modelo diciendo "esta fila no es un dato"
     * en voz alta — un título de sección, un total. Eso es una decisión y se respeta.
     *
     * Antes esa decisión se expresaba OMITIENDO la fila, y por eso era indistinguible de un
     * fallo. Ahora omitir es una anomalía y saltar es un veredicto.
     */
    expect(faltantes([v(0), v(1, 'skip'), v(2)], 3)).toEqual([]);
  });
});
