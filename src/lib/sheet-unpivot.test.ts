import { describe, expect, test } from 'bun:test';
import {
  claveDeConceptoAncho,
  despivotarReporte,
  esRenglonDeTotal,
  inferirAnio,
  mesDeEncabezado,
} from './sheet-unpivot';

/**
 * La garantía: la matriz de gastos de una PYME entra a su contabilidad, y un estado de
 * resultados NO.
 *
 * Las dos hojas tienen la MISMA forma —concepto a la izquierda, un mes por columna— así que
 * este módulo es el que más daño puede hacer del pipeline: despivotar un P&L duplicaría los
 * ingresos del cliente. Por eso es una lista blanca y ante la duda devuelve `null`.
 */

const MESES = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio'];

/** La matriz de gastos real de KapePrueba, recortada. Es lo que HAY que despivotar. */
const GASTOS = [
  [null, 'Concepto', 'Tipo', ...MESES, 'Total', 'Promedio'],
  [null, 'Alquiler de local y bodega', 'Fijo', 1500, 1500, 1500, 1500, 1500, 1500, 9000, 1500],
  [null, 'Sueldos y bonificación', 'Fijo', 2800, 2800, 2800, 2800, 2800, 2800, 16800, 2800],
  [null, 'Energía eléctrica y agua', 'Variable', 410, 430, 455, 402, 448, 461, 2606, 434],
  [null, 'Publicidad y redes', 'Variable', 600, 640, 590, 610, 655, 605, 3700, 617],
]; // prettier-ignore

/** El estado de resultados de KapePrueba, recortado. NUNCA debe despivotarse. */
const ESTADO = [
  [null, 'Concepto', ...MESES, 'Acumulado'],
  [null, 'Ventas netas', 26172, 27684, 29602, 28848, 32124, 33226, 177656],
  [null, '(-) Costo de ventas', -15003, -16035, -17016, -16806, -18103, -18987, -101950],
  [null, 'Utilidad bruta', 11169, 11649, 12586, 12042, 14021, 14239, 75706],
  [null, '(-) Gastos operativos', -5310, -5370, -5345, -5312, -5403, -5366, -32106],
  [null, 'Utilidad neta', 5859, 6279, 7241, 6730, 8618, 8873, 43600],
]; // prettier-ignore

const OPC = { anioPorDefecto: 2026 };
const sumaDe = (rows: unknown[][]) =>
  rows.slice(1).reduce((a, f) => a + Number(f[f.length - 1]), 0);

describe('la matriz de gastos SÍ se convierte en movimientos', () => {
  test('un movimiento por concepto y mes, con la plata intacta', () => {
    const r = despivotarReporte(GASTOS, OPC);
    expect(r).not.toBeNull();
    // 4 conceptos × 6 meses. La fila de Total NO está (no la hay acá) y las columnas
    // `Total`/`Promedio` tampoco se despivotan: no son meses.
    expect(r!.rows.length - 1).toBe(24);
    expect(r!.conceptos).toBe(4);
    expect(r!.periodos).toBe(6);
    // La suma tiene que ser la de las celdas de mes, ni un centavo más.
    const esperado = 9000 + 16800 + 2606 + 3700;
    expect(sumaDe(r!.rows)).toBeCloseTo(esperado, 2);
  });

  test('la columna Total NO se cuenta como un mes', () => {
    // Es el error que duplicaría el gasto anual del cliente: `Total` y `Promedio` están al
    // lado de los meses y se ven igual de numéricas.
    const r = despivotarReporte(GASTOS, OPC)!;
    const fechas = new Set(r.rows.slice(1).map((f) => String(f[0])));
    expect(fechas.size).toBe(6);
    expect([...fechas].sort()).toEqual([
      '2026-01-01', '2026-02-01', '2026-03-01', '2026-04-01', '2026-05-01', '2026-06-01',
    ]); // prettier-ignore
  });

  test('la fecha es el día 1 y no el último del mes', () => {
    /*
     * Con el último día, el mes EN CURSO queda fechado en el futuro y se sale de cualquier
     * filtro "hasta hoy" del dashboard: se perdería justo el mes que el cliente mira.
     */
    const r = despivotarReporte(GASTOS, OPC)!;
    for (const f of r.rows.slice(1)) expect(String(f[0])).toMatch(/-01$/);
  });

  test('la columna Tipo se conserva como Grupo', () => {
    // Es lo que deja al cliente separar sus gastos fijos de los variables, que es para lo
    // que tenía esa columna.
    const r = despivotarReporte(GASTOS, OPC)!;
    expect(r.rows[0]).toEqual(['Fecha', 'Concepto', 'Grupo', 'Monto']);
    const fijos = r.rows.slice(1).filter((f) => f[2] === 'Fijo');
    expect(fijos.length).toBe(12);
  });

  test('un mes en cero no genera movimiento', () => {
    const conCero = [
      [null, 'Concepto', ...MESES],
      [null, 'Ferias y mercados', 0, 0, 1200, 0, 0, 900],
      [null, 'Alquiler', 1500, 1500, 1500, 1500, 1500, 1500],
    ]; // prettier-ignore
    const r = despivotarReporte(conCero, OPC)!;
    expect(r.rows.length - 1).toBe(2 + 6);
    expect(sumaDe(r.rows)).toBeCloseTo(1200 + 900 + 9000, 2);
  });

  test('la fila TOTAL se excluye, pero no descalifica la hoja', () => {
    const conTotal = [...GASTOS, [null, 'TOTAL GASTOS OPERATIVOS', '', 5310, 5370, 5345, 5312, 5403, 5366, 32106, 5351]]; // prettier-ignore
    const r = despivotarReporte(conTotal, OPC);
    expect(r).not.toBeNull();
    expect(r!.conceptos).toBe(4);
    expect(sumaDe(r!.rows)).toBeCloseTo(9000 + 16800 + 2606 + 3700, 2);
  });
});

describe('un estado financiero NO se despivota', () => {
  test('el estado de resultados se rechaza', () => {
    expect(despivotarReporte(ESTADO, OPC)).toBeNull();
  });

  test('el flujo de caja se rechaza', () => {
    const flujo = [
      [null, 'Concepto', ...MESES],
      [null, 'Saldo inicial de caja', 24500, 16220, 17987, 13945, 15363, 16614],
      [null, 'Cobros de clientes', 16662, 16344, 18562, 15797, 22096, 22310],
      [null, 'Pagos a proveedores', 9800, 12651, 14662, 14593, 16513, 13883],
      [null, 'Saldo final de caja', 16220, 17987, 13945, 15363, 16614, 21891],
    ]; // prettier-ignore
    expect(despivotarReporte(flujo, OPC)).toBeNull();
  });

  test('UNA sola línea de estado descalifica la hoja entera', () => {
    /*
     * No se despivota "lo que se pueda": si la hoja es un estado, sus renglones de gasto
     * TAMBIÉN están en la hoja de detalle que los origina, y quedarse con ellos contaría de
     * más. El todo-o-nada es la decisión, no un atajo.
     */
    const mezcla = [...GASTOS, [null, 'Utilidad bruta', '', 1, 2, 3, 4, 5, 6, 21, 3]]; // prettier-ignore
    expect(despivotarReporte(mezcla, OPC)).toBeNull();
  });

  test('un solo valor negativo descalifica la hoja', () => {
    // El signo es la firma de un estado: el costo se resta del ingreso. Una matriz de gastos
    // es toda de la misma naturaleza y va toda en positivo.
    const conNegativo = GASTOS.map((f) => [...f]);
    conNegativo[2]![3] = -2800;
    expect(despivotarReporte(conNegativo, OPC)).toBeNull();
  });

  test('un estado escrito TODO en positivo se rechaza igual, por el vocabulario', () => {
    // El signo solo no alcanza: hay estados que no usan negativos. Por eso las dos guardas.
    const positivo = ESTADO.map((f) => f.map((c) => (typeof c === 'number' ? Math.abs(c) : c)));
    expect(despivotarReporte(positivo, OPC)).toBeNull();
  });
});

describe('lo que no es una matriz por mes se deja en paz', () => {
  test('menos de tres meses no es una matriz', () => {
    const dos = [
      [null, 'Concepto', 'Enero', 'Febrero'],
      [null, 'Alquiler', 1500, 1500],
      [null, 'Sueldos', 2800, 2800],
    ]; // prettier-ignore
    expect(despivotarReporte(dos, OPC)).toBeNull();
  });

  test('una tabla de movimientos normal no se toca', () => {
    const ventas = [
      ['Fecha', 'Cliente', 'Producto', 'Monto'],
      [46024, 'Ana', 'Café', 100],
      [46025, 'Luis', 'Té', 200],
    ]; // prettier-ignore
    expect(despivotarReporte(ventas, OPC)).toBeNull();
  });

  test('un mes repetido (bloques a lo ancho) se rechaza', () => {
    /*
     * `Enero Costo` / `Enero Venta` a lo ancho: una celda sola no dice QUÉ es ese número, y
     * despivotar mezclaría los dos conceptos en una sola columna de monto.
     */
    const bloques = [
      [null, 'Producto', 'Enero', 'Enero', 'Febrero', 'Febrero', 'Marzo', 'Marzo'],
      [null, 'Café', 10, 20, 11, 21, 12, 22],
      [null, 'Té', 30, 40, 31, 41, 32, 42],
    ]; // prettier-ignore
    expect(despivotarReporte(bloques, OPC)).toBeNull();
  });

  test('sin columna de concepto no hay a qué atribuir el monto', () => {
    const sinConcepto = [
      ['Enero', 'Febrero', 'Marzo', 'Abril'],
      [1500, 1500, 1500, 1500],
      [2800, 2800, 2800, 2800],
    ]; // prettier-ignore
    expect(despivotarReporte(sinConcepto, OPC)).toBeNull();
  });
});

describe('el año: equivocarse manda los gastos a donde nadie los busca', () => {
  test('el encabezado gana cuando trae el año', () => {
    const conAnio = [
      [null, 'Concepto', 'ene-24', 'feb-24', 'mar-24'],
      [null, 'Alquiler', 1500, 1500, 1500],
      [null, 'Sueldos', 2800, 2800, 2800],
    ]; // prettier-ignore
    const r = despivotarReporte(conAnio, { anioPorDefecto: 2026 })!;
    expect(String(r.rows[1]![0])).toBe('2024-01-01');
  });

  test('el título de la hoja se usa cuando el mes no dice año', () => {
    expect(inferirAnio({ titulo: 'Gastos operativos mensuales 2025' })).toBe(2025);
  });

  test('las fechas del resto del libro son el respaldo más fuerte', () => {
    // Son movimientos reales de esa contabilidad: mejor evidencia que cualquier heurística.
    expect(
      inferirAnio({ fechasDelLibro: ['2024-03-05', '2024-07-19', '2024-01-02', '2025-01-01'] }),
    ).toBe(2024);
  });

  test('el nombre de la hoja va antes que las fechas', () => {
    expect(inferirAnio({ nombreHoja: 'Gastos 2023', fechasDelLibro: ['2026-01-01'] })).toBe(2023);
  });
});

describe('piezas sueltas', () => {
  test('mesDeEncabezado lee las formas que traen los archivos reales', () => {
    expect(mesDeEncabezado('Enero')).toEqual({ mes: 1, anio: null });
    expect(mesDeEncabezado('ene-26')).toEqual({ mes: 1, anio: 2026 });
    expect(mesDeEncabezado('Diciembre 2025')).toEqual({ mes: 12, anio: 2025 });
    expect(mesDeEncabezado('2026-07')).toEqual({ mes: 7, anio: 2026 });
    expect(mesDeEncabezado('07/2026')).toEqual({ mes: 7, anio: 2026 });
    expect(mesDeEncabezado('setiembre')).toEqual({ mes: 9, anio: null });
  });

  test('mesDeEncabezado NO confunde una columna cualquiera con un mes', () => {
    for (const n of ['Total', 'Promedio', 'Concepto', 'Tipo', 'Cliente', 'Monto', '', 'Marca']) {
      expect(mesDeEncabezado(n)).toBeNull();
    }
  });

  test('esRenglonDeTotal reconoce las formas con adorno', () => {
    expect(esRenglonDeTotal('TOTAL GASTOS OPERATIVOS')).toBe(true);
    expect(esRenglonDeTotal('Total gastos fijos')).toBe(true);
    expect(esRenglonDeTotal('  Acumulado')).toBe(true);
    expect(esRenglonDeTotal('Alquiler de local')).toBe(false);
    // "Total" tiene que ir al PRINCIPIO: un rubro puede nombrarla al pasar.
    expect(esRenglonDeTotal('Servicios con total variable')).toBe(false);
  });
});

/*
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA CUARTA GUARDA: EL RESUMEN QUE NINGUNA DE LAS OTRAS TRES PODÍA VER
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *
 * `02_Restaurante_ElFogon` (archivo real) trae `CostosYGastos` con 180 filas de detalle y
 * `ReporteMensualGastos` con 6 categorías × 12 meses, cuyo subtítulo dice literalmente
 * "Resumen ya consolidado, uso interno de gerencia".
 *
 * Ese resumen es INDISTINGUIBLE de la matriz legítima de KapePrueba mirando la hoja sola:
 * todo positivo, ningún vocabulario de agregado, una fila por rubro. Pasaba las tres primeras
 * guardas y duplicaba los gastos del restaurante. `sheet-duplication` tampoco lo atrapaba: los
 * totales difieren 1,08 % —el detalle cubre 20 meses y el resumen 12— contra su umbral del 1 %.
 *
 * La señal no está en la hoja: está en el LIBRO. Medido, 100 % de solape en el restaurante
 * contra 0 % en KapePrueba.
 */
describe('un consolidado de otra hoja no se despivota', () => {
  const RESUMEN_DEL_RESTAURANTE = [
    ['Categoria', 'Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio'],
    ['Compra de insumos', 4699, 20673, 6827, 18965, 17850, 21804],
    ['Renta de Local', 15111, 14242, 15727, 5872, 24517, 8730],
    ['Planilla', 19252, 11466, 3363, 8378, 17085, 18132],
    ['Servicios', 3100, 3250, 3080, 3300, 3190, 3410],
  ]; // prettier-ignore

  /** Lo que trae la columna `Categoria` de la hoja de detalle. */
  const CATEGORIAS_DEL_DETALLE = new Set(
    ['Compra de insumos', 'Renta de Local', 'Planilla', 'Servicios', 'Marketing'].map(
      claveDeConceptoAncho,
    ),
  );

  test('sin el contexto del libro se despivota (es lo que hacían las tres guardas)', () => {
    expect(despivotarReporte(RESUMEN_DEL_RESTAURANTE, { anioPorDefecto: 2026 })).not.toBeNull();
  });

  test('con el contexto del libro se rechaza', () => {
    expect(
      despivotarReporte(RESUMEN_DEL_RESTAURANTE, {
        anioPorDefecto: 2026,
        conceptosDeMovimientos: CATEGORIAS_DEL_DETALLE,
      }),
    ).toBeNull();
  });

  test('la matriz legítima NO se rechaza por conceptos ajenos', () => {
    // Los gastos de KapePrueba no aparecen en ninguna hoja de movimientos de su libro.
    expect(
      despivotarReporte(GASTOS, {
        anioPorDefecto: 2026,
        conceptosDeMovimientos: CATEGORIAS_DEL_DETALLE,
      }),
    ).not.toBeNull();
  });

  test('UNA coincidencia suelta no tumba una hoja legítima', () => {
    /*
     * Un rubro puede llamarse igual que un texto cualquiera de otra hoja por casualidad. Se
     * exigen al menos dos coincidencias Y la mitad de los conceptos, porque el costo de
     * rechazar de más es real: el cliente vuelve a ver GTQ 0.00 de gastos.
     */
    const casiTodoPropio = new Set([claveDeConceptoAncho('Alquiler de local y bodega')]);
    expect(
      despivotarReporte(GASTOS, {
        anioPorDefecto: 2026,
        conceptosDeMovimientos: casiTodoPropio,
      }),
    ).not.toBeNull();
  });

  test('el solape se mide sin acentos ni mayúsculas', () => {
    // "Renta de Local" y "renta de local" son el mismo rubro; compararlos crudos diría que no.
    const conMayusculas = new Set(
      ['COMPRA DE INSUMOS', 'Renta  de  Local', 'planilla', 'Servicios'].map(claveDeConceptoAncho),
    );
    expect(
      despivotarReporte(RESUMEN_DEL_RESTAURANTE, {
        anioPorDefecto: 2026,
        conceptosDeMovimientos: conMayusculas,
      }),
    ).toBeNull();
  });
});
