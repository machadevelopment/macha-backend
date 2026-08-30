import { describe, expect, test } from 'bun:test';
import {
  claveDeConceptoAncho,
  despivotarReporte,
  esRenglonDeTotal,
  inferirAnio,
  mesDeEncabezado,
} from './sheet-unpivot';
import { pareceNombreDePeriodo } from './sheet-shape';

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

/*
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * QUINTA GUARDA: LA ARITMÉTICA DE LA HOJA (2026-08-30)
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *
 * Las guardas de vocabulario y de solape fallan las dos contra un estado de resultados escrito
 * con etiquetas GENÉRICAS. Encontrado generando libros hostiles a propósito.
 */
describe('un estado con etiquetas genéricas se rechaza por su aritmética', () => {
  const M = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio'];

  test('Ingresos / Egresos / Diferencia: ninguna palabra delata, la identidad sí', () => {
    /*
     * `Ingresos = Egresos + Diferencia` es la misma identidad que `Utilidad = Ventas − Costos`
     * escrita con otras palabras, y ninguna de las tres está —ni puede estar— en la lista de
     * agregados: "ingresos" es también el nombre legítimo de un rubro.
     */
    const pyl = [
      ['Rubro', ...M],
      ['Ingresos', 8000, 8200, 7900, 8400, 8100, 8300],
      ['Egresos', 3000, 3100, 2900, 3200, 3050, 3150],
      ['Diferencia', 5000, 5100, 5000, 5200, 5050, 5150],
    ]; // prettier-ignore
    expect(despivotarReporte(pyl, { anioPorDefecto: 2026 })).toBeNull();
  });

  test('el negocio rentable también se rechaza (no depende del signo)', () => {
    // La guarda 1 (sin negativos) salvaba este caso solo cuando la empresa daba pérdida.
    const conPerdida = [
      ['Rubro', ...M],
      ['Ingresos', 5219, 5300, 5100, 5400, 5250, 5350],
      ['Egresos', 6440, 6500, 6300, 6600, 6450, 6550],
      ['Diferencia', -1221, -1200, -1200, -1200, -1200, -1200],
    ]; // prettier-ignore
    expect(despivotarReporte(conPerdida, { anioPorDefecto: 2026 })).toBeNull();
  });

  test('un subtotal ANIDADO se excluye, pero la hoja sobrevive', () => {
    /*
     * `Servicios` = `Agua` + `Luz`: un bloque contiguo, no la suma de todo. Rechazar la hoja
     * entera perdería alquiler y sueldos, que son gastos reales. Se quita el renglón y ya.
     */
    const anidada = [
      ['Concepto', ...M],
      ['Agua', 180, 195, 172, 188, 201, 176],
      ['Luz', 250, 268, 241, 259, 275, 246],
      ['Servicios', 430, 463, 413, 447, 476, 422],
      ['Alquiler', 1500, 1500, 1500, 1500, 1500, 1500],
      ['Sueldos', 2800, 2800, 2800, 2800, 2800, 2800],
    ]; // prettier-ignore
    const r = despivotarReporte(anidada, { anioPorDefecto: 2026 });
    expect(r).not.toBeNull();
    expect(r!.conceptos).toBe(4);
    const suma = r!.rows.slice(1).reduce((a, f) => a + Number(f[f.length - 1]), 0);
    const esperado = [180,195,172,188,201,176,250,268,241,259,275,246].reduce((a,b)=>a+b,0) + (1500+2800)*6; // prettier-ignore
    expect(suma).toBeCloseTo(esperado, 2);
  });

  test('la tolerancia es ESTRECHA: una coincidencia del 0,36 % no es una identidad', () => {
    /*
     * Con tolerancia del 0,5 % apareció el falso positivo enseguida: en una matriz de seis
     * rubros, `Sueldos` (2.800) quedaba a 0,36 % de la suma de los otros cinco (2.790) por
     * casualidad, y la hoja se rechazaba entera — el cliente volvía a ver cero en gastos.
     */
    const casualidad = [
      ['Concepto', ...M],
      ['Agua', 180, 180, 180, 180, 180, 180],
      ['Luz', 250, 250, 250, 250, 250, 250],
      ['Alquiler', 1500, 1500, 1500, 1500, 1500, 1500],
      ['Sueldos', 2800, 2800, 2800, 2800, 2800, 2800],
      ['Energía', 430, 430, 430, 430, 430, 430],
    ]; // prettier-ignore
    // 180+250+1500+430 = 2360 ≠ 2800 en este arreglo; el caso real tenía seis filas.
    expect(despivotarReporte(casualidad, { anioPorDefecto: 2026 })).not.toBeNull();
  });
});

describe('una matriz TRIMESTRAL también es una matriz', () => {
  test('Q1..Q4 se despivotan al primer mes de su trimestre', () => {
    /*
     * Hay negocios que presupuestan por trimestre. Sin reconocerlos, la hoja ni siquiera se
     * detectaba como reporte: caía al camino normal, se quedaba sin columna de fecha y se
     * descartaba entera (Q 77.280 medidos en el libro de prueba).
     */
    const tri = [
      ['Concepto', 'Q1 2026', 'Q2 2026', 'Q3 2026', 'Q4 2026', 'Total'],
      ['Alquiler de local', 4500, 4500, 4500, 4500, 18000],
      ['Sueldos administrativos', 8400, 8400, 8400, 8400, 33600],
    ]; // prettier-ignore
    const r = despivotarReporte(tri, { anioPorDefecto: 2026 });
    expect(r).not.toBeNull();
    expect(r!.periodos).toBe(4);
    // El primer día del trimestre, para que caiga dentro del filtro "Este trimestre".
    expect(r!.rows.slice(1).map((f) => String(f[0]))).toContain('2026-01-01');
    expect(r!.rows.slice(1).map((f) => String(f[0]))).toContain('2026-04-01');
    expect(r!.rows.slice(1).map((f) => String(f[0]))).toContain('2026-07-01');
    expect(r!.rows.slice(1).map((f) => String(f[0]))).toContain('2026-10-01');
  });

  test('las formas en español y en inglés', () => {
    for (const [etq, mes] of [
      ['Q1', 1],
      ['T2', 4],
      ['3T', 7],
      ['4to trimestre', 10],
      ['Trimestre 2', 4],
      ['q4-26', 10],
    ] as [string, number][]) {
      expect(mesDeEncabezado(etq)?.mes).toBe(mes);
    }
  });

  test('un ACUMULADO trimestral NO es un período', () => {
    /*
     * `Acumulado Q1` es el subtotal de los tres meses de al lado, no un período más. Leerlo
     * como trimestre lo haría chocar con los meses que resume.
     */
    expect(mesDeEncabezado('Acumulado Q1')).toBeNull();
    expect(mesDeEncabezado('Total Q1')).toBeNull();
    expect(mesDeEncabezado('Q5')).toBeNull();
    expect(mesDeEncabezado('Tienda 1')).toBeNull();
  });
});

describe('las dos funciones de período tienen que coincidir', () => {
  test('lo que sheet-shape llama período, sheet-unpivot sabe traducirlo', () => {
    /*
     * Si `pareceNombreDePeriodo` dice "sí" y `mesDeEncabezado` devuelve null, la hoja se marca
     * como reporte y después no se puede despivotar: se descarta igual, que es el peor de los
     * dos mundos. Fue exactamente lo que pasó con los trimestres.
     */
    const etiquetas = [
      'Q1','Q1 2026','q4-26','T1','1T','1er trimestre','Trimestre 2','2do trim',
      'Enero','ene-26','2026-01','01/2026','Diciembre','dic-25',
      'Acumulado Q1','Total','Promedio','Rubro','Concepto','Cliente','Monto','Tienda 1','Q5','IV',
    ]; // prettier-ignore
    for (const e of etiquetas) {
      expect([e, pareceNombreDePeriodo(e)]).toEqual([e, mesDeEncabezado(e) !== null]);
    }
  });
});

describe('dos períodos bastan si las etiquetas traen el año', () => {
  /*
   * El mínimo de tres existe porque "una columna que parece un mes" es evidencia débil. Pero
   * una columna rotulada `S1 2026` no admite otra lectura, y una matriz semestral tiene
   * exactamente dos. Sin esto se descartaba entera (Q 77.280 medidos) y ni siquiera llegaba al
   * modelo: sin columna de fecha, `noPuedeProducirMovimientos` la tira antes.
   */
  test('una matriz SEMESTRAL con año explícito se despivota', () => {
    const sem = [
      ['Concepto', 'S1 2026', 'S2 2026', 'Total'],
      ['Alquiler de local', 9000, 9000, 18000],
      ['Sueldos administrativos', 16800, 16800, 33600],
    ]; // prettier-ignore
    const r = despivotarReporte(sem, { anioPorDefecto: 2026 });
    expect(r).not.toBeNull();
    expect(r!.periodos).toBe(2);
    expect(r!.rows.slice(1).map((f) => String(f[0])).sort()).toEqual([
      '2026-01-01', '2026-01-01', '2026-07-01', '2026-07-01',
    ]); // prettier-ignore
  });

  test('SIN año explícito siguen haciendo falta tres', () => {
    // "Enero" puede ser el nombre de una persona o de una sucursal; `S1 2026` no.
    const dos = [
      ['Concepto', 'Enero', 'Febrero'],
      ['Alquiler de local', 1500, 1500],
      ['Sueldos administrativos', 2800, 2800],
    ]; // prettier-ignore
    expect(despivotarReporte(dos, { anioPorDefecto: 2026 })).toBeNull();
  });

  test('las formas de semestre', () => {
    expect(mesDeEncabezado('S1 2026')).toEqual({ mes: 1, anio: 2026 });
    expect(mesDeEncabezado('S2')).toEqual({ mes: 7, anio: null });
    expect(mesDeEncabezado('1er semestre')).toEqual({ mes: 1, anio: null });
    expect(mesDeEncabezado('Semestre 2')).toEqual({ mes: 7, anio: null });
    expect(mesDeEncabezado('S3')).toBeNull();
  });
});
