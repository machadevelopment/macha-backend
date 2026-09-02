import { describe, expect, test } from 'bun:test';
import type { ClaveDeOpcion } from './destinos-de-la-fila';
import { destinosDeLaFila, destinosDeLaHoja, opcionesParaConcepto } from './destinos-de-la-fila';

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * A QUÉ PANTALLAS LLEGA CADA FILA (reporte de Jose, 2026-09-01)
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *
 * *"La data no va únicamente al dashboard… si ponemos solo los del dashboard y el campo va a
 * cuentas por pagar, no lo estamos registrando."*
 *
 * Lo que se prueba acá son las combinaciones donde una fila llega a MÁS de una pantalla, que es
 * justo lo que el portón no decía: listar solo la cuenta esconde la mitad que el cliente ve en
 * su dashboard, y listar solo el rubro esconde la cuenta.
 */
describe('destinosDeLaFila', () => {
  const fila = (targetEntity: 'transaction' | 'invoice' | 'bill', payload: object) =>
    destinosDeLaFila({ targetEntity, payload: payload as Record<string, unknown> }).sort();

  test('una venta simple: ingresos del período', () => {
    expect(fila('transaction', { type: 'revenue' })).toEqual(['flujo', 'ingresos']);
  });

  test('una FACTURA EMITIDA llega a Por cobrar Y a Ingresos', () => {
    /*
     * Las dos caras del mismo hecho: emitirla devenga el ingreso y crea el derecho de cobro
     * (regla del 2026-08-19). Decir solo "Por cobrar" escondería que también movió el
     * dashboard, que es donde el dueño mira primero.
     */
    expect(fila('invoice', { type: 'revenue' })).toEqual(['flujo', 'ingresos', 'porCobrar']);
  });

  test('una CUENTA POR PAGAR llega a Por pagar Y a Costos', () => {
    // Simétrico: desde el 2026-08-30 una factura recibida produce su costo.
    expect(fila('bill', { type: 'cogs' })).toEqual(['costos', 'flujo', 'porPagar']);
  });

  test('una venta CON PRODUCTO alimenta además Ventas por producto', () => {
    expect(fila('transaction', { type: 'revenue', product: 'Aceite 1 L' })).toEqual([
      'flujo',
      'ingresos',
      'productos',
    ]);
  });

  test('una COMPRA con producto NO va a Ventas por producto', () => {
    /*
     * Esa pantalla agrupa los INGRESOS por producto. Contar ahí una compra diría que un
     * producto vendió lo que en realidad costó.
     */
    expect(fila('transaction', { type: 'cogs', product: 'Aceite 1 L' })).toEqual([
      'costos',
      'flujo',
    ]);
  });

  test('⚠️ `other` se declara SIN PANTALLA, y eso es el punto', () => {
    /*
     * `rollups.ts` suma `revenue`, `cogs` y `opex`: una fila `other` se guarda y **no aparece
     * en ninguna cifra**. Jose preguntó por escrito dónde caía ("¿y si fuera otro movimiento,
     * en dónde lo registra?") y la respuesta honesta es "en ningún lado que se vea". Decirlo
     * en el portón es lo que le permite corregirlo ANTES de publicar en vez de descubrirlo por
     * una cifra que no cuadra.
     */
    expect(fila('transaction', { type: 'other' })).toEqual(['sinPantalla']);
  });

  test('una fila sin tipo todavía declara su cuenta', () => {
    // Llega marcada y la contesta el cliente, pero ya se sabe que es una cuenta por pagar.
    expect(fila('bill', {})).toEqual(['porPagar']);
  });
});

describe('destinosDeLaHoja', () => {
  test('es la UNIÓN de sus filas, sin repetir', () => {
    /*
     * Una hoja de ventas con costo en la línea produce ingreso Y costo: si la pantalla
     * mostrara solo el destino de la primera fila, diría la mitad.
     */
    const r = destinosDeLaHoja([
      { targetEntity: 'transaction', payload: { type: 'revenue', product: 'Aceite' } },
      { targetEntity: 'transaction', payload: { type: 'cogs' } },
      { targetEntity: 'transaction', payload: { type: 'revenue' } },
    ]).sort();
    expect(r).toEqual(['costos', 'flujo', 'ingresos', 'productos']);
  });
});

describe('el desglose por TIENDA', () => {
  const fila = (targetEntity: 'transaction' | 'invoice' | 'bill', payload: object) =>
    destinosDeLaFila({ targetEntity, payload: payload as Record<string, unknown> }).sort();

  test('una venta con tienda alimenta Ventas por tienda', () => {
    /*
     * El desglose por tienda vive DENTRO de Ventas por producto y es una pantalla más donde el
     * dato aterriza: Jose la nombró al pedir "todas las opciones en donde registremos data".
     */
    expect(fila('transaction', { type: 'revenue', store: 'Zona 10' })).toEqual([
      'flujo',
      'ingresos',
      'tiendas',
    ]);
  });

  test('un GASTO con tienda NO va al desglose por tienda', () => {
    /*
     * Ese donut reparte las VENTAS del período. Un gasto con sucursal contaría ahí como si esa
     * tienda hubiera vendido lo que en realidad gastó — el mismo error que con `product`.
     */
    expect(fila('transaction', { type: 'opex', store: 'Zona 10' })).toEqual(['costos', 'flujo']);
  });

  test('una tienda en blanco no es una señal', () => {
    expect(fila('transaction', { type: 'revenue', store: '   ' })).toEqual(['flujo', 'ingresos']);
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LAS OPCIONES DE LA TARJETA DE CONCEPTOS (reporte de Jose, 2026-09-02)
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *
 * *"Solo añadiste dos, debería ser bueno mostrar absolutamente todas las que tenemos en
 * Macha… que se muestren todas siempre de una manera bonita y ordenada."*
 */
describe('opcionesParaConcepto', () => {
  const claves = (o: ReturnType<typeof opcionesParaConcepto>) => o.map((x) => x.clave);

  test('SIEMPRE son las seis, en el mismo orden', () => {
    /*
     * Esto es el pedido literal, y el motivo es más profundo que la estética: una lista que
     * cambia de largo según la fila no se puede aprender. Antes las dos de cuenta aparecían
     * "solo a veces" y el dueño lo reportó como inconsistente.
     */
    const seis: ClaveDeOpcion[] = ['revenue', 'cogs', 'opex', 'other', 'invoice', 'bill'];
    expect(claves(opcionesParaConcepto({ entity: 'transaction', hoja: 'Ventas' }))).toEqual(seis);
    expect(claves(opcionesParaConcepto({ entity: 'invoice', hoja: null }))).toEqual(seis);
    expect(claves(opcionesParaConcepto({ entity: 'bill', hoja: 'Compras' }))).toEqual(seis);
  });

  test('lo que no se puede elegir se APAGA con su motivo, no desaparece', () => {
    const o = opcionesParaConcepto({ entity: 'invoice', hoja: 'Facturacion' });
    const invoice = o.find((x) => x.clave === 'invoice')!;
    // Ya es una cuenta por cobrar: no hay nada que cambiar, y ese es el motivo útil.
    expect(invoice.disponible).toBe(false);
    expect(invoice.motivo).toBe('yaEsAsi');
    // La otra cuenta sí se puede elegir: la hoja es una sola.
    expect(o.find((x) => x.clave === 'bill')!.disponible).toBe(true);
  });

  test('con VARIAS hojas ninguna cuenta se puede elegir, y se dice por qué', () => {
    /*
     * Cambiar la entidad reprocesa la hoja ENTERA. Con dos hojas tocaría las dos, que no es lo
     * que el cliente está pidiendo — pero la opción se sigue mostrando con su motivo en vez de
     * desaparecer sin explicación.
     */
    const o = opcionesParaConcepto({ entity: 'transaction', hoja: null });
    for (const k of ['invoice', 'bill'] as const) {
      const x = o.find((y) => y.clave === k)!;
      expect(x.disponible).toBe(false);
      expect(x.motivo).toBe('variasHojas');
    }
  });

  test('⚠️ `yaEsAsi` gana a `variasHojas`', () => {
    // Al revés, un concepto que ya está donde debe mostraría un impedimento que no le importa.
    const o = opcionesParaConcepto({ entity: 'bill', hoja: null });
    expect(o.find((x) => x.clave === 'bill')!.motivo).toBe('yaEsAsi');
    expect(o.find((x) => x.clave === 'invoice')!.motivo).toBe('variasHojas');
  });

  test('⚠️ los destinos de los TIPOS se calculan sobre la entidad ACTUAL', () => {
    /*
     * Es la mitad del pedido. Para una fila que YA es cuenta por cobrar, contestar "es un
     * ingreso" no la manda solo al dashboard: la deja en Por cobrar Y en Ingresos. Calcular
     * siempre como `transaction` volvería a mostrar únicamente los rubros del dashboard, que
     * es exactamente el hueco que se está cerrando.
     */
    const o = opcionesParaConcepto({ entity: 'invoice', hoja: 'Facturacion' });
    expect(o.find((x) => x.clave === 'revenue')!.destinos.sort()).toEqual([
      'flujo',
      'ingresos',
      'porCobrar',
    ]);
  });

  test('las señales de producto y tienda viajan a los destinos de cada opción', () => {
    const o = opcionesParaConcepto({
      entity: 'transaction',
      hoja: 'Ventas',
      senales: { producto: true, tienda: true },
    });
    expect(o.find((x) => x.clave === 'revenue')!.destinos.sort()).toEqual([
      'flujo',
      'ingresos',
      'productos',
      'tiendas',
    ]);
    // Y no se filtran a un gasto, que no aparece en esas dos pantallas.
    expect(o.find((x) => x.clave === 'opex')!.destinos.sort()).toEqual(['costos', 'flujo']);
  });

  test('las dos de cuenta prometen el destino que la REGLA CONTABLE garantiza', () => {
    /*
     * El tipo que van a tener después del reproceso lo decide el modelo al releer la hoja. Lo
     * que sí se puede afirmar es la regla: la factura emitida devenga su ingreso (2026-08-19) y
     * la recibida produce su costo (2026-08-30).
     */
    const o = opcionesParaConcepto({ entity: 'transaction', hoja: 'Ventas' });
    expect(o.find((x) => x.clave === 'invoice')!.destinos.sort()).toEqual([
      'flujo',
      'ingresos',
      'porCobrar',
    ]);
    expect(o.find((x) => x.clave === 'bill')!.destinos.sort()).toEqual([
      'costos',
      'flujo',
      'porPagar',
    ]);
  });

  test('`other` no promete ninguna pantalla', () => {
    const o = opcionesParaConcepto({ entity: 'transaction', hoja: 'Ventas' });
    expect(o.find((x) => x.clave === 'other')!.destinos).toEqual(['sinPantalla']);
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * EL RUBRO SALE DE LA DERIVACIÓN REAL, NO DEL `type` DE LA FILA (2026-09-02)
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *
 * Corregido VIENDO LA PROMESA FALSA EN PRODUCCIÓN: para un concepto que ya es cuenta por
 * pagar, la opción "Un ingreso" mostraba `Por pagar · Ingresos · Flujo de caja`. Los chips
 * existen para que el dueño decida informado; uno que miente es peor que no ponerlo.
 *
 * `rollups.ts` suma revenue/cogs/opex **solo de `transactions`**, así que una factura aparece
 * en el estado de resultados únicamente si `construirFilas` derivó su transacción — y esa
 * derivación tiene reglas propias y DISTINTAS para cada entidad.
 */
describe('el rubro reproduce lo que `construirFilas` deriva de verdad', () => {
  const fila = (targetEntity: 'transaction' | 'invoice' | 'bill', payload: object) =>
    destinosDeLaFila({ targetEntity, payload: payload as Record<string, unknown> }).sort();

  test('⚠️ una `bill` con `revenue` NO llega a Ingresos', () => {
    /*
     * La derivación de una `bill` exige `cogs` u `opex`: *"si el modelo no lo dio, no se
     * inventa… es preferible un costo ausente y visible en revisión a un margen falso que
     * nadie puede desmentir"*. Con `revenue` no se deriva nada, así que la fila entra a Por
     * pagar y no suma en ninguna cifra. Este es el caso exacto que se vio mal en producción.
     */
    expect(fila('bill', { type: 'revenue' })).toEqual(['porPagar']);
  });

  test('…y tampoco con `other`, pero SÍ sigue apareciendo en Por pagar', () => {
    /*
     * No lleva `sinPantalla`: esa etiqueta significa "no aparece en ningún lado", y una cuenta
     * por pagar aparece en Por pagar. Decir lo contrario sería la misma mentira del otro lado.
     */
    expect(fila('bill', { type: 'other' })).toEqual(['porPagar']);
  });

  test('una `invoice` devenga su ingreso SEA CUAL SEA el tipo de la fila', () => {
    /*
     * `construirFilas` arma el ingreso con `type: 'revenue'` FIJO — no mira el que dio el
     * modelo. Emitirla devenga, y eso no depende de cómo se rotule la fila. Mostrar `Costos`
     * porque el `type` diga `cogs` prometería un rubro que el ledger nunca va a tener.
     */
    for (const t of ['revenue', 'cogs', 'opex', 'other']) {
      expect(fila('invoice', { type: t })).toEqual(['flujo', 'ingresos', 'porCobrar']);
    }
  });

  test('una `transaction` con `other` no aparece en ninguna pantalla', () => {
    // Acá sí: no hay cuenta que la sostenga, así que el conjunto queda vacío de verdad.
    expect(fila('transaction', { type: 'other' })).toEqual(['sinPantalla']);
  });

  test('⚠️ sin tipo NO se dice "no aparece en ningún lado"', () => {
    /*
     * Esa fila está sin clasificar y va a revisión: no es que no tenga pantalla, es que
     * todavía no se sabe. Decirlo al revés le diría al dueño que su dato se perdió cuando lo
     * que falta es su propia respuesta.
     */
    expect(fila('transaction', {})).toEqual([]);
    expect(fila('bill', {})).toEqual(['porPagar']);
  });

  test('el producto solo cuenta si de verdad hay ingreso derivado', () => {
    // Una `bill` con producto y `cogs` mueve Costos, nunca Ventas por producto.
    expect(fila('bill', { type: 'cogs', product: 'Aceite 1 L' })).toEqual([
      'costos',
      'flujo',
      'porPagar',
    ]);
  });
});
