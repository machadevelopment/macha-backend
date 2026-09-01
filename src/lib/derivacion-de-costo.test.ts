import { describe, expect, test } from 'bun:test';
import {
  ES_DERIVADA,
  SIN_DERIVAR,
  costoDeCuentaPorPagar,
  esFilaDerivada,
  esTipoDeEgreso,
  yaTieneSuCosto,
} from './derivacion-de-costo';

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * EL COSTO QUE EL CLIENTE DESBLOQUEA AL CONTESTAR
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *
 * Medido en producción antes del arreglo: 12 órdenes de compra por GTQ 56.391,00 — el 82 % del
 * costo real del libro — quedaron como cuenta por pagar sin transacción de costo. El cliente
 * contestó "es un costo", las filas marcadas bajaron de 15 a 3, y el estado de resultados no
 * se movió.
 */
const BILL = {
  counterparty: 'Proveedor 4',
  issueDate: '2026-04-15',
  dueDate: '2026-05-15',
  originalAmount: 14547.3,
  originalCurrency: 'GTQ',
};

describe('cuándo hay que derivar', () => {
  test('una cuenta por pagar SIN tipo todavía no tiene su costo', () => {
    expect(yaTieneSuCosto(BILL)).toBe(false);
  });

  test('con tipo válido ya lo derivó la ingesta: no se deriva dos veces', () => {
    // `construirFilas` deriva cuando el modelo da `t`. Si acá se volviera a derivar, el costo
    // entraría por duplicado en cuanto la fila cayera a revisión por confianza baja.
    expect(yaTieneSuCosto({ ...BILL, type: 'cogs' })).toBe(true);
    expect(yaTieneSuCosto({ ...BILL, type: 'opex' })).toBe(true);
  });

  test('un tipo que NO es de egreso no cuenta como derivado', () => {
    // `revenue` en una cuenta por pagar sería registrar como ingreso lo que la empresa debe.
    expect(yaTieneSuCosto({ ...BILL, type: 'revenue' })).toBe(false);
    expect(esTipoDeEgreso('revenue')).toBe(false);
    expect(esTipoDeEgreso('other')).toBe(false);
  });

  test('⚠️ la marca de supresión gana: el libro ya registra esa compra en otra hoja', () => {
    /*
     * Sin esta marca el arreglo se come su propia guarda. Una `bill` que la ingesta suprimió a
     * propósito llega a revisión SIN tipo, igual que una que el modelo no supo clasificar, y
     * desde el handler de la respuesta son indistinguibles: el cliente contestaría y el costo
     * entraría por segunda vez — que es justo lo que `compraYaRegistradaEnOtraHoja` evita.
     */
    expect(yaTieneSuCosto({ ...BILL, [SIN_DERIVAR]: true })).toBe(true);
  });
});

describe('la fila de costo que se arma', () => {
  test('se ARMA DE NUEVO: lleva `date`, `type` y `category`, no los campos de la factura', () => {
    const f = costoDeCuentaPorPagar({
      payload: BILL,
      type: 'cogs',
      category: 'compras de mercaderia',
    })!;

    expect(f.type).toBe('cogs');
    expect(f.category).toBe('compras de mercaderia');
    expect(f.originalAmount).toBe(14547.3);
    expect(f.originalCurrency).toBe('GTQ');
    // La contraparte describe el hecho: sin esto la fila queda sin nombre en el dashboard.
    expect(f.description).toBe('Proveedor 4');
    // Un spread habría dejado la fila sin `date` y `staging-rules` la marcaría por
    // `invalid_date`, que es el error que cometió el primer intento de la factura emitida.
    expect(f.issueDate).toBeUndefined();
    expect(f.dueDate).toBeUndefined();
  });

  test('la fecha es la de EMISIÓN, nunca la de vencimiento', () => {
    // Usar el vencimiento mueve el costo de período: es el error de la contabilidad de caja.
    const f = costoDeCuentaPorPagar({ payload: BILL, type: 'cogs', category: 'x' })!;
    expect(f.date).toBe('2026-04-15');
    expect(f.date).not.toBe(BILL.dueDate);
  });

  test('el monto entra en POSITIVO: la dirección la lleva `type`', () => {
    // `staging-rules` exige positivo en las dos formas de payload; un negativo se marcaría.
    const f = costoDeCuentaPorPagar({
      payload: { ...BILL, originalAmount: -14547.3 },
      type: 'cogs',
      category: 'x',
    })!;
    expect(f.originalAmount).toBe(14547.3);
  });

  test('sin monto o sin fecha NO se inventa nada', () => {
    // Preferible un costo ausente y visible en revisión a uno inventado que nadie desmiente.
    expect(
      costoDeCuentaPorPagar({
        payload: { ...BILL, originalAmount: null },
        type: 'cogs',
        category: 'x',
      }),
    ).toBeNull();
    expect(
      costoDeCuentaPorPagar({
        payload: { ...BILL, originalAmount: 0 },
        type: 'cogs',
        category: 'x',
      }),
    ).toBeNull();
    expect(
      costoDeCuentaPorPagar({ payload: { ...BILL, issueDate: null }, type: 'cogs', category: 'x' }),
    ).toBeNull();
  });

  test('el total de las 12 órdenes de compra medidas en producción se recupera entero', () => {
    const ordenes = [14547.3, 14247.6, 13947.9, 13648.2];
    const total = ordenes
      .map((monto) =>
        costoDeCuentaPorPagar({
          payload: { ...BILL, originalAmount: monto },
          type: 'cogs',
          category: 'x',
        })!,
      )
      .reduce((suma, f) => suma + (f.originalAmount as number), 0);
    expect(total).toBeCloseTo(56391.0, 2);
  });
});

describe('la respuesta del cliente NO pisa una fila derivada', () => {
  /*
   * Medido en producción el 2026-09-01, con el portón puesto: el concepto "Aceite 1 L"
   * agrupaba DOS filas —la venta de GTQ 1.890 y su costo derivado de GTQ 1.160, que comparten
   * `product`—. El dueño contestó "es un ingreso", que es CIERTO de su venta, y con eso
   * convirtió el costo en ingreso: **+1.160 de ingreso y −1.160 de costo**.
   *
   * El total del archivo cuadraba al centavo, así que el error era invisible; lo que se movía
   * era el MARGEN BRUTO, que es cifra de portada.
   */
  const venta = { type: 'revenue', category: 'ventas', date: '2026-04-18', product: 'Aceite 1 L', originalAmount: 1890, originalCurrency: 'GTQ' }; // prettier-ignore
  const costo = { ...venta, type: 'cogs', category: 'costo_de_ventas', originalAmount: 1160, [ES_DERIVADA]: true }; // prettier-ignore

  test('la venta se puede contestar; el costo derivado se reconoce como tal', () => {
    expect(esFilaDerivada(venta)).toBe(false);
    expect(esFilaDerivada(costo)).toBe(true);
  });

  test('⚠️ las dos caen en el MISMO concepto, y eso está bien', () => {
    /*
     * Agrupar por producto es lo que hace contestable la pantalla cuando la hoja no trae
     * descripción (medido: de 4.686 filas marcadas en producción, 977 solo tienen `product`).
     * No se cambia. Lo que estaba mal era aplicarle al costo una respuesta dada sobre la venta.
     */
    expect(venta.product).toBe(costo.product);
  });

  test('el costo derivado conserva `cogs` aunque el cliente diga "es un ingreso"', () => {
    const respuesta = { type: 'revenue', category: 'ventas de producto' };
    const aplicar = (p: Record<string, unknown>) =>
      esFilaDerivada(p) ? p : { ...p, ...respuesta };

    expect((aplicar(venta) as { type: string }).type).toBe('revenue');
    // Si esto dijera `revenue`, el margen bruto del cliente vuelve a moverse 1.160 sin que
    // nada falle y con el total cuadrando.
    expect((aplicar(costo) as { type: string }).type).toBe('cogs');
    expect((aplicar(costo) as { category: string }).category).toBe('costo_de_ventas');
  });
});
