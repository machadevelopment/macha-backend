import { describe, expect, test } from 'bun:test';
import { construirFilas, type VeredictoCrudo } from './anthropic';
import { SYSTEM_PROMPT } from './anthropic';
import type { ColumnMap } from './row-assembly';

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * UNA FACTURA RECIBIDA ES UN COSTO ADEMÁS DE UNA CUENTA POR PAGAR (2026-08-30)
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *
 * Es el fallo SIMÉTRICO del de la factura emitida, y estuvo abierto porque el razonamiento se
 * detuvo a mitad de camino. La nota escrita decía:
 *
 *     "Una `bill` NO produce ingreso: sería registrar como ingreso lo que la empresa debe."
 *
 * Cierto, y sigue vigente. Lo que faltaba decir es que **sí produce un COSTO**. Se confundió
 * "no es ingreso" con "no es nada", y el resultado es que una fila `bill` creaba la cuenta por
 * pagar y **desaparecía del estado de resultados**: `rollups.ts` suma `cogs` y `opex`
 * únicamente de `transactions`, igual que suma `revenue`.
 *
 * Mismo modo de fallo que dejó a U3TECH con cero ingresos, del otro lado del balance: el dato
 * se lee bien, se clasifica bien, se guarda bien, y el dashboard no lo muestra. Afecta a toda
 * empresa que registre las facturas de sus proveedores en una hoja de cuentas por pagar en vez
 * de anotarlas como gasto pagado, que es como se lleva la contabilidad por devengo.
 */

const COLUMNAS: ColumnMap = {
  date: 0, amount: 3, currency: 4, description: 2, counterparty: 1, product: null,
  quantity: null, productCategory: null, store: null, dueDate: null, costTotal: null,
  costUnit: null,
}; // prettier-ignore

const FILA = ['2026-03-14', 'Finca La Esperanza', 'Café oro, 110 kg', 6380, 'GTQ'];

const armar = (v: Partial<VeredictoCrudo>, opciones: Record<string, unknown> = {}) =>
  construirFilas(
    new Map([[0, { i: 0, e: 'bill', t: null, c: 'cafe_oro', cf: 0.95, ...v } as VeredictoCrudo]]),
    { rows: [FILA], baseCurrency: 'GTQ', ...opciones },
    COLUMNAS,
  );

describe('la cuenta por pagar produce su costo', () => {
  test('una factura de mercadería produce la deuda Y el costo directo', () => {
    const filas = armar({ t: 'cogs' });
    expect(filas.map((f) => f.targetEntity).sort()).toEqual(['bill', 'transaction']);
    const costo = filas.find((f) => f.targetEntity === 'transaction')!.payload as {
      type: string;
      originalAmount: number;
      date: string;
    };
    expect(costo.type).toBe('cogs');
    expect(costo.originalAmount).toBe(6380);
    // La fecha es la de EMISIÓN, no la de vencimiento: usar la de pago movería el costo de
    // período, que es el error que comete la contabilidad de caja.
    expect(costo.date).toBe('2026-03-14');
  });

  test('una factura de alquiler produce gasto operativo, no costo directo', () => {
    const costo = armar({ t: 'opex' }).find((f) => f.targetEntity === 'transaction')!.payload as {
      type: string;
    };
    expect(costo.type).toBe('opex');
  });

  test('NUNCA produce un ingreso', () => {
    // Sería registrar como ingreso lo que la empresa debe. La regla original se conserva.
    for (const t of ['cogs', 'opex', 'revenue', 'other'] as const) {
      const tipos = armar({ t }).map((f) => (f.payload as { type?: string }).type);
      expect([t, tipos.includes('revenue')]).toEqual([t, false]);
    }
  });

  test('sin tipo NO se inventa uno: queda la deuda y la fila va a revisión', () => {
    /*
     * Elegir `opex` por defecto inflaría el margen bruto de cualquier comercio que compre
     * inventario a crédito. Un costo ausente y visible es preferible a un margen falso que
     * nadie puede desmentir.
     */
    const filas = armar({ t: null });
    expect(filas.map((f) => f.targetEntity)).toEqual(['bill']);
  });

  test('si la compra YA está registrada en otra hoja, no se deriva el costo', () => {
    /*
     * Contraparte exacta de la regla de la factura emitida: un libro con `Compras` (el
     * detalle) y `CuentasPorPagar` (apuntando a esas mismas compras) contaría el costo dos
     * veces. Lo decide el esquema del libro, no el nombre de la hoja.
     */
    const filas = armar({ t: 'cogs' }, { compraYaRegistradaEnOtraHoja: true });
    expect(filas.map((f) => f.targetEntity)).toEqual(['bill']);
  });

  test('una fila sin monto o sin fecha legibles no deriva costo', () => {
    // La `bill` ya se emitió y `staging-rules` la evalúa por su cuenta; agregar una
    // transacción que igual va a caer marcada solo duplica el trabajo de revisión.
    const sinFecha = construirFilas(
      new Map([[0, { i: 0, e: 'bill', t: 'cogs', c: 'x', cf: 0.9 }]]),
      { rows: [['sin fecha', 'Proveedor', 'x', 6380, 'GTQ']], baseCurrency: 'GTQ' },
      COLUMNAS,
    );
    expect(sinFecha.map((f) => f.targetEntity)).toEqual(['bill']);
  });
});

describe('el prompt fija la frontera entre costo directo y gasto', () => {
  /*
   * Hasta hoy el prompt decía solo `"t" está limitado a revenue/cogs/opex/other` y dejaba la
   * frontera al criterio del modelo. Eso hace que el MARGEN BRUTO —cifra de portada— salga
   * distinto entre dos corridas del mismo archivo, y distinto de cualquier referencia externa
   * contra la que el dueño lo compare.
   */
  test('nombra lo que NUNCA es costo directo', () => {
    for (const gasto of ['alquiler', 'planilla', 'publicidad', 'marketing', 'honorarios']) {
      expect([gasto, SYSTEM_PROMPT.toLowerCase().includes(gasto)]).toEqual([gasto, true]);
    }
  });

  test('nombra lo que SÍ es costo directo', () => {
    for (const costo of [
      'mercadería para reventa',
      'materia prima',
      'mano de obra de producción',
    ]) {
      expect([costo, SYSTEM_PROMPT.toLowerCase().includes(costo)]).toEqual([costo, true]);
    }
  });

  test('el desempate ante la duda es opex, y está escrito', () => {
    // Inflar el costo directo hunde el margen bruto, que es la cifra con la que el dueño
    // decide sus precios.
    expect(SYSTEM_PROMPT).toContain('Ante la duda entre los dos, "opex"');
  });

  test('pide el tipo también en las cuentas por pagar', () => {
    expect(SYSTEM_PROMPT).toContain('"bill" (cuenta por pagar) devolver TAMBIÉN "t"');
  });
});

/*
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * UN COBRO NO ES UNA VENTA NUEVA (2026-08-30)
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *
 * `ventaYaRegistradaEnOtraHoja` protegía ÚNICAMENTE a las filas `invoice`. Una hoja de cobros
 * tiene fecha, cliente y monto, así que lo natural es que el modelo la clasifique
 * `transaction/revenue` — y ahí nada la frenaba.
 *
 * Medido: `Facturacion` (40 facturas, Q 238.387) + `Cobros` (20 de esas mismas facturas,
 * apuntando por `Documento`, Q 124.432) daba Q 362.819 de ingreso, **52 % más** que la
 * facturación real. El dinero de una venta cobrada se contaba al emitirla Y al cobrarla.
 */
describe('un cobro liquida una factura, no crea ingreso', () => {
  const COBROS: ColumnMap = {
    date: 1, amount: 3, currency: null, description: null, counterparty: 2, product: null,
    quantity: null, productCategory: null, store: null, dueDate: null, costTotal: null,
    costUnit: null,
  }; // prettier-ignore
  const FILAS = [
    ['FAC-001', '2026-08-10', 'Cafetería El Roble', 5000],
    ['FAC-002', '2026-08-14', 'Súper Zona 10', 3200],
  ];
  const correr = (yaRegistrada: boolean) =>
    construirFilas(
      new Map(
        FILAS.map((_, i) => [
          i,
          { i, e: 'transaction', t: 'revenue', c: 'cobro', cf: 0.95 } as VeredictoCrudo,
        ]),
      ),
      { rows: FILAS, baseCurrency: 'GTQ', ventaYaRegistradaEnOtraHoja: yaRegistrada },
      COBROS,
    );

  test('si la venta YA está registrada en otra hoja, el cobro no produce nada', () => {
    expect(correr(true)).toHaveLength(0);
  });

  test('una hoja de cobros SUELTA sí registra su dinero', () => {
    /*
     * Lo que la guarda NO desactiva: solo actúa cuando el esquema del libro demuestra la
     * referencia. Sin hoja de facturación al lado, esa hoja ES la única fuente del ingreso y
     * silenciarla dejaría al cliente en cero — el error simétrico y peor.
     */
    expect(correr(false)).toHaveLength(2);
  });

  test('la guarda corre ANTES de emitir la fila, no después', () => {
    /*
     * El primer intento puso el `continue` más abajo, después de que la fila ya se había
     * empujado a la salida, así que solo evitaba el desdoble del costo y el ingreso duplicado
     * seguía entrando. Una guarda que corre después de emitir no guarda nada.
     *
     * Este test lo fija midiendo el TOTAL emitido, que es lo que llega al dashboard.
     */
    const total = correr(true).reduce(
      (a, f) => a + Number((f.payload as { originalAmount?: number }).originalAmount ?? 0),
      0,
    );
    expect(total).toBe(0);
  });
});
