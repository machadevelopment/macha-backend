import { describe, expect, test } from 'bun:test';
import { evaluarCuadre, evaluarCuadrePorHoja, hojasDescuadradas } from './cuadre';

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA PROPIEDAD QUE JUSTIFICA EL CUADRE POR HOJA: DOS ERRORES OPUESTOS SE CANCELAN
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *
 * El cuadre por documento suma todas las hojas y compara contra el ledger. Eso es exactamente
 * lo que no sirve contra los fallos de COMPOSICIÓN, que son los que llevamos meses
 * persiguiendo: **una hoja que aterriza el doble y otra que aterriza cero dan un total
 * perfecto**.
 *
 * Los dos casos reales tienen esa forma:
 *   · KapePrueba — el dedup conservó un resumen de 11 filas y descartó `Ventas` (481) y
 *     `Compras` (43); la única cifra del dashboard fueron Q 13.362 de una cartera de clientes
 *     leída como ingresos.
 *   · CarsGT — 81 cuentas por cobrar devengaron un ingreso que `Ventas` ya había contado,
 *     mientras 260 vehículos en stock entraban como costo.
 *
 * Este archivo fija la propiedad, no un caso: con las MISMAS cifras, el cuadre del documento
 * dice "cuadra" y el de hojas señala las dos culpables. Si algún día el de documento empezara a
 * detectarlo, este test se pone en rojo y hay que venir a leer por qué.
 */
describe('cuadre por hoja contra cuadre por documento', () => {
  /** `Ventas` se duplicó; `Gastos` se perdió entera. El total del libro no lo nota. */
  const VENTAS = { leido: 1_000, aterrizado: 2_000 };
  const GASTOS = { leido: 1_000, aterrizado: 0 };

  test('el cuadre del DOCUMENTO no ve nada: los dos errores se cancelan', () => {
    const c = evaluarCuadre(
      [{ moneda: 'GTQ', monto: VENTAS.leido + GASTOS.leido, costo: 0 }],
      [{ moneda: 'GTQ', monto: VENTAS.aterrizado + GASTOS.aterrizado }],
    );

    expect(c).toHaveLength(1);
    expect(c[0]!.veredicto).toBe('cuadra');
    // Y la razón es exactamente 1,00: no es que pase raspando, es que es indistinguible de
    // una carga perfecta.
    expect(c[0]!.razon).toBe(1);
  });

  test('el cuadre por HOJA señala a las dos, y dice qué le pasó a cada una', () => {
    const porHoja = evaluarCuadrePorHoja([
      {
        hoja: 'Ventas',
        leido: [{ moneda: 'GTQ', monto: VENTAS.leido, costo: 0 }],
        aterrizado: [{ moneda: 'GTQ', monto: VENTAS.aterrizado }],
      },
      {
        hoja: 'Gastos',
        leido: [{ moneda: 'GTQ', monto: GASTOS.leido, costo: 0 }],
        aterrizado: [{ moneda: 'GTQ', monto: GASTOS.aterrizado }],
      },
    ]);

    expect(porHoja.map((h) => `${h.hoja}:${h.cuadres[0]!.veredicto}`)).toEqual([
      'Ventas:sobra',
      'Gastos:nada_aterrizo',
    ]);

    /*
     * `sobra` y `nada_aterrizo` son veredictos distintos a propósito: piden acciones opuestas.
     * Uno significa que la misma plata se contó dos veces; el otro, que hay una hoja que nadie
     * sabe dónde quedó. Meterlos en el mismo cajón haría que el caro se pierda entre los
     * rutinarios, que es el mismo motivo por el que `en_revision` ya está separado de `falta`.
     */
    expect(hojasDescuadradas(porHoja).map((d) => d.hoja)).toEqual(['Ventas', 'Gastos']);
  });

  test('una expansión legítima por hoja no dispara: la factura que devenga su ingreso', () => {
    /*
     * Una hoja de facturación produce DOS filas de ledger por fila del archivo (la cuenta por
     * cobrar y el ingreso devengado). Sin declarar la expansión eso se leería como duplicación
     * —que es justamente lo que hay que atrapar en la otra hoja—, así que la banda se calcula
     * con la expansión que ESA hoja produjo, no con la del libro.
     */
    const porHoja = evaluarCuadrePorHoja([
      {
        hoja: 'Facturacion',
        leido: [{ moneda: 'USD', monto: 5_000, costo: 0 }],
        aterrizado: [{ moneda: 'USD', monto: 10_000 }],
        expansion: 2,
      },
    ]);

    expect(porHoja[0]!.cuadres[0]!.veredicto).toBe('cuadra');
    expect(hojasDescuadradas(porHoja)).toHaveLength(0);
  });

  test('lo que espera en revisión no se cuenta como pérdida', () => {
    // Es un estado NORMAL: el dinero está identificado y con dueño. Confundirlo con una hoja
    // perdida haría que el caso caro se pierda entre decenas del rutinario.
    const porHoja = evaluarCuadrePorHoja([
      {
        hoja: 'Gastos',
        leido: [{ moneda: 'GTQ', monto: 1_000, costo: 0 }],
        aterrizado: [{ moneda: 'GTQ', monto: 400 }],
        enRevision: [{ moneda: 'GTQ', monto: 600 }],
      },
    ]);

    expect(porHoja[0]!.cuadres[0]!.veredicto).toBe('en_revision');
    expect(hojasDescuadradas(porHoja)).toHaveLength(0);
  });
});
