import { describe, expect, test } from 'bun:test';

process.env.DATABASE_URL ??= 'postgres://smoke:smoke@localhost:5432/smoke';

const {
  indexarVeredictos,
  hayDesplazamiento,
  fusionarMapaDeColumnas,
  construirFilas,
  SheetColumnMapMismatchError,
} = await import('./anthropic');
type ColumnMap = import('./row-assembly').ColumnMap;

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

describe('el mapa de columnas de la hoja', () => {
  const MAPA: ColumnMap = {
    date: 2,
    amount: 13,
    currency: null,
    description: null,
    counterparty: 5,
    product: 6,
    quantity: 7,
    productCategory: 12,
    dueDate: null,
    costTotal: null,
    costUnit: null,
  };
  const NULOS: ColumnMap = {
    date: null,
    amount: null,
    currency: null,
    description: null,
    counterparty: null,
    product: null,
    quantity: null,
    productCategory: null,
    dueDate: null,
    costTotal: null,
    costUnit: null,
  };

  test('dos lotes con el mismo mapa no cambian nada', () => {
    expect(fusionarMapaDeColumnas('Ventas', MAPA, { ...MAPA })).toEqual(MAPA);
  });

  test('UN VALOR CONTRA NULL NO ES CONFLICTO — el bug que salió a producción', () => {
    /*
     * Este guardia se escribió comparando con `!==`, así que `amount: 7 vs null` contaba como
     * contradicción y tumbaba el documento entero. Rompió subidas reales de clientes el
     * 2026-08-14 (hojas "Racum 2025" y "Ventas_Diarias"): documentos abortados y atascados
     * en `processing`.
     *
     * Un lote devuelve null cuando SU tramo de filas no permite ver la columna —un bloque de
     * totales, filas vacías—. No afirma que la columna no exista: dice que ahí no la
     * distingue. El otro lote no lo contradice, lo completa.
     */
    expect(() => fusionarMapaDeColumnas('Racum 2025', MAPA, NULOS)).not.toThrow();
    expect(fusionarMapaDeColumnas('Racum 2025', MAPA, NULOS)).toEqual(MAPA);
  });

  test('lo que un lote sí vio COMPLETA lo que el otro no', () => {
    // El motivo de fusionar en vez de solo tolerar: el lote que no distinguió la descripción
    // arma sus filas con la del lote que sí la vio, en vez de dejarlas sin descripción.
    const conDescripcion = { ...MAPA, description: 4 };
    expect(fusionarMapaDeColumnas('Ventas', MAPA, conDescripcion).description).toBe(4);
    expect(fusionarMapaDeColumnas('Ventas', conDescripcion, MAPA).description).toBe(4);
  });

  test('la fusión da igual en qué orden lleguen los lotes', () => {
    // Los lotes de una hoja corren en paralelo: el primero en TERMINAR fija el canónico. Si
    // el resultado dependiera del orden, el mismo archivo daría datos distintos entre
    // corridas.
    const a = { ...MAPA, description: 4 };
    const b = { ...NULOS, amount: 13, currency: 9 };
    expect(fusionarMapaDeColumnas('V', a, b)).toEqual(fusionarMapaDeColumnas('V', b, a));
  });

  test('discrepar en PRODUCTO no tumba el archivo', () => {
    /*
     * Observado en un archivo real (2026-08-14, hoja "Racum 2025"): un lote leyó
     * `product: 2` (Calidad = "Kapel Blend") y otro `product: 3` (Presentación = "Molido").
     * Los dos son defendibles — la hoja es ambigua, el modelo no está fallando.
     *
     * La primera versión de este guardia abortaba igual que con las columnas de dinero, y el
     * documento entero se caía. Intercambiar producto y categoría desordena etiquetas; NO
     * falsea un solo quetzal. Dejar al cliente sin nada es estrictamente peor.
     */
    expect(() =>
      fusionarMapaDeColumnas('Racum 2025', MAPA, { ...MAPA, product: 3, productCategory: 6 }),
    ).not.toThrow();
    // Gana el canónico, para que toda la hoja quede etiquetada igual.
    expect(fusionarMapaDeColumnas('Racum 2025', MAPA, { ...MAPA, product: 3 }).product).toBe(
      MAPA.product,
    );
  });

  test('discrepar en la CANTIDAD sí aborta, aunque no sea un monto', () => {
    // De `quantity` salen las unidades vendidas Y el costo de la línea cuando la hoja da el
    // costo por unidad. Leerla mal multiplica o divide el costo — es una columna de números.
    expect(() => fusionarMapaDeColumnas('Ventas', MAPA, { ...MAPA, quantity: 9 })).toThrow(
      SheetColumnMapMismatchError,
    );
  });

  test('dos columnas de dinero DISTINTAS sí abortan', () => {
    /*
     * La corrupción de verdad, y la única. El lote 1 lee `TotalLinea` (13) y el lote 7 lee
     * `PrecioUnitario` (8): las dos son columnas de dinero creíbles, así que media hoja
     * entraría con el precio de una unidad en vez del total de la línea.
     *
     * Ningún validador lo atraparía — `staging-rules` solo exige un número positivo, y
     * 272,99 lo es tanto como 491,38.
     */
    expect(() => fusionarMapaDeColumnas('Ventas', MAPA, { ...MAPA, amount: 8 })).toThrow(
      SheetColumnMapMismatchError,
    );
  });

  test('el error dice QUÉ columna difiere, no solo que difiere', () => {
    // Quien lo lea en `documents.error_reason` tiene que poder abrir el archivo y mirar esas
    // dos columnas. "Los mapas no coinciden" mandaría a leer el prompt, que no es el problema.
    try {
      fusionarMapaDeColumnas('Ventas', MAPA, { ...MAPA, amount: 8, date: 3 });
      throw new Error('debió lanzar');
    } catch (e) {
      expect((e as Error).message).toContain('amount: 13 vs 8');
      expect((e as Error).message).toContain('date: 2 vs 3');
    }
  });
});

describe('una venta que trae su costo produce DOS transacciones', () => {
  const CAFETERIA: ColumnMap = {
    date: 0, product: 2, productCategory: 3, quantity: 4,
    amount: 6, costTotal: 7, costUnit: null,
    currency: null, description: null, counterparty: null, dueDate: null,
  }; // prettier-ignore
  const FILA = [46174, 'P01', 'Café Americano', 'Bebidas Calientes', 6, 18, 108, 27, 81]; // prettier-ignore

  const armar = (e: string, t: string | null, columns = CAFETERIA) =>
    construirFilas(
      new Map([[0, { i: 0, e, t, c: 'ventas', cf: 0.95 }]]) as never,
      { rows: [FILA], baseCurrency: 'GTQ' },
      columns,
    );

  test('sale la venta y sale el costo, con el mismo producto y la misma fecha', () => {
    /*
     * El costo por producto sale de transacciones `type = 'cogs'` ligadas al producto. Sin
     * la fila de costo, la pantalla de Ventas por producto mostraba GTQ 0.00 y 100 % de
     * margen en todo — que es exactamente lo que se vio en producción el 2026-08-14.
     *
     * Fecha y producto se heredan porque es el mismo hecho económico visto por su otra
     * cara: sin la fecha no cae en el mismo período, sin el producto no entra al mismo
     * margen.
     */
    const filas = armar('transaction', 'revenue');
    expect(filas).toHaveLength(2);

    const [venta, costo] = filas.map(
      (f: { payload: unknown }) => f.payload as Record<string, unknown>,
    );
    expect(venta!.type).toBe('revenue');
    expect(venta!.originalAmount).toBe(108);
    expect(costo!.type).toBe('cogs');
    expect(costo!.originalAmount).toBe(27);
    expect(costo!.product).toBe(venta!.product);
    expect(costo!.date).toBe(venta!.date);
  });

  test('las unidades NO se repiten en la fila de costo', () => {
    // Ya las contó la venta. Repetirlas duplicaría cualquier conteo de unidades vendidas.
    const [venta, costo] = armar('transaction', 'revenue').map(
      (f) => f.payload as Record<string, unknown>,
    );
    expect(venta!.quantity).toBe(6);
    expect(costo!.quantity).toBe(null);
  });

  test('una fila ya clasificada como costo NO se desdobla', () => {
    // Su monto YA es el costo. Agregarle otro lo duplicaría y hundiría el margen.
    expect(armar('transaction', 'cogs')).toHaveLength(1);
  });

  test('una factura no se desdobla', () => {
    // Una cuenta por cobrar o por pagar no lleva costo de ventas propio.
    expect(armar('invoice', null)).toHaveLength(1);
  });

  test('sin columna de costo, sigue saliendo una sola fila', () => {
    const sinCosto = { ...CAFETERIA, costTotal: null, costUnit: null };
    expect(armar('transaction', 'revenue', sinCosto)).toHaveLength(1);
  });
});
