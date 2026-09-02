import { describe, expect, test } from 'bun:test';
import { camposDeLaFila } from './campos-de-la-fila';

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * EL PORTÓN ENSEÑA LOS CAMPOS DE TODAS LAS PANTALLAS (reporte de Jose, 2026-09-01)
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *
 * *"No solo los campos del dashboard, sino los campos de analítica y los campos de inventario.
 * Los campos realmente cabal son los campos que vos ya tenés en la base de datos, o sea que
 * sólo con agregarlos ahí deberíamos estar check."*
 *
 * Mostraba seis campos elegidos a mano —los del estado de resultados— y el pipeline extrae
 * once. El que más faltaba: `dueDate`.
 */
describe('camposDeLaFila', () => {
  const claves = (p: object) => camposDeLaFila(p as Record<string, unknown>).map((c) => c.clave);

  test('⚠️ una cuenta por cobrar enseña su VENCIMIENTO, no solo la emisión', () => {
    /*
     * Es el campo que decide el tramo de antigüedad (corriente, 1-30, 31-60, 61-90, 90+), o sea
     * cómo se ve toda la pantalla de Por cobrar. Un vencimiento mal leído manda la cartera al
     * tramo equivocado **sin cambiar un solo total**, así que el cuadre no lo ve y el dueño
     * tampoco lo veía.
     */
    expect(
      claves({ counterparty: 'Cliente 2', issueDate: '2026-01-07', dueDate: '2026-02-06' }),
    ).toEqual(['emision', 'vencimiento', 'contraparte']);
  });

  test('una venta enseña producto, cantidad y tienda', () => {
    // Ventas por producto e Inventario: las otras dos pantallas que Jose nombró.
    expect(
      claves({
        date: '2026-03-01',
        description: 'Venta mostrador',
        product: 'Aceite 1 L',
        productCategory: 'Abarrotes',
        quantity: 3,
        store: 'TDA-01',
      }),
    ).toEqual(['fecha', 'descripcion', 'producto', 'categoriaProducto', 'cantidad', 'tienda']);
  });

  test('un campo AUSENTE no se pinta', () => {
    /*
     * Una hoja de gastos no tiene producto ni tienda, y seis renglones vacíos convierten la
     * pantalla en ruido — que es justo lo que hace que el dueño deje de leerla.
     */
    expect(claves({ date: '2026-03-01', description: 'Alquiler' })).toEqual([
      'fecha',
      'descripcion',
    ]);
  });

  test('NO repite el monto, la moneda ni el tipo', () => {
    // La pantalla ya los pinta aparte y con formato propio; duplicarlos los mostraría dos veces.
    expect(
      claves({ date: '2026-03-01', originalAmount: 100, originalCurrency: 'GTQ', type: 'opex' }),
    ).toEqual(['fecha']);
  });

  test('una cantidad de CERO sí se pinta', () => {
    /*
     * `0` es un valor legítimo del inventario y significa algo —no hay existencia—; tratarlo
     * como ausente escondería justo la fila que el dueño tiene que mirar.
     */
    expect(claves({ quantity: 0 })).toEqual(['cantidad']);
  });
});
