import { describe, expect, test } from 'bun:test';
import * as XLSX from 'xlsx';
import { detectarFilaDeEncabezado } from './sheet-header';
import { analizarFormaDeHoja } from './sheet-shape';
import { detectarDetalleDuplicado } from './sheet-duplication';
import {
  canSkipSheet,
  firmaDeCatalogo,
  noPuedeProducirMovimientos,
  pareceLibroDeMovimientos,
} from './sheet-classifier';
import { analizarEsquema } from './sheet-relations';
import {
  asDate,
  asNumber,
  assemblePayload,
  detectarOrdenDeFecha,
  type ColumnMap,
  type RowVerdict,
} from './row-assembly';
import { evaluateFlagReason } from './staging-rules';
import { claveDeConceptoAncho, despivotarReporte, inferirAnio } from './sheet-unpivot';

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * EL ÚNICO TEST QUE AFIRMA LA CIFRA DEL DASHBOARD, Y NO UN FILTRO
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *
 * Todos los demás tests de ingesta afirman el veredicto de UN paso: que tal hoja se clasifica
 * así, que tal fila se marca asá. Eso deja pasar la clase de fallo que más ha costado, y de la
 * que hay seis reportes: **dos pasos que por separado están bien y juntos vacían el libro.**
 * `Resumen_Mensual` ganaba el dedup (defendible) y el filtro siguiente lo descartaba
 * (defendible), y el cliente veía cero.
 *
 * Este test arma un libro con la VERDAD DE CAMPO conocida —lo genera, así que sabe cuánto
 * ingreso, costo y gasto hay de verdad—, lo pasa por TODOS los pasos pre-modelo reales, por el
 * ensamblado real y por `staging-rules` real, y compara la suma final contra esa verdad.
 *
 * ═══ EL MODELO ES UN DOBLE, Y ESO ES EL PUNTO ═══
 *
 * En lugar de Claude hay un clasificador determinista que ACIERTA SIEMPRE. No se prueba al
 * modelo: se aísla la variable. Si con un modelo perfecto la cifra sale mal, el defecto está
 * en el código — que es lo que resultó ser en los seis reportes.
 *
 * Cada hoja de abajo está para romper algo distinto, y todas se rompieron de verdad alguna vez.
 */

const r2 = (n: number) => Math.round(n * 100) / 100;
const serial = (iso: string) =>
  Math.round((Date.parse(`${iso}T00:00:00Z`) - Date.UTC(1899, 11, 30)) / 86_400_000);

/* ═══════════════════ EL LIBRO, Y LA VERDAD QUE LO ACOMPAÑA ═══════════════════ */

const verdad = { revenue: 0, cogs: 0, opex: 0 };
const anota = (k: keyof typeof verdad, v: number) => (verdad[k] = r2(verdad[k] + v));

/** Ventas: encabezado en la fila 3, fechas como SERIAL, y el costo en la misma fila. */
const ventas: unknown[][] = [
  ['Tostaduría de Prueba, S.A.'],
  ['Registro de ventas 2026'],
  [],
  ['Fecha', 'Documento', 'Cliente', 'Producto', 'Cantidad', 'Venta Neta', 'Moneda', 'Costo Total'],
];
for (let m = 1; m <= 8; m++) {
  for (let k = 0; k < 6; k++) {
    const venta = 1000 + m * 100 + k * 10;
    const costo = r2(venta * 0.45);
    anota('revenue', venta);
    anota('cogs', costo);
    ventas.push([
      serial(`2026-${String(m).padStart(2, '0')}-${String(3 + k).padStart(2, '0')}`),
      `VTA-${m}${k}`,
      'Cafetería El Roble',
      'Café en grano 1 kg',
      2,
      venta,
      'GTQ',
      costo,
    ]);
  }
}
/** Renglón de TOTAL al final: el modelo lo declara `skip` y no genera movimiento. */
ventas.push(['', '', '', 'TOTAL GENERAL', '', 999_999, 'GTQ', '']);

/**
 * Resumen mensual DERIVADO de Ventas, con el período escrito como SERIAL.
 * Si se procesa, la facturación se cuenta dos veces.
 */
const resumen: unknown[][] = [['Mes', 'Venta Neta', 'Unidades']];
for (let m = 1; m <= 8; m++) {
  let suma = 0;
  for (let k = 0; k < 6; k++) suma += 1000 + m * 100 + k * 10;
  resumen.push([serial(`2026-${String(m).padStart(2, '0')}-01`), suma, 12]);
}

/** Nómina: fechas escritas en ESPAÑOL. Sin parsearlas, la hoja entera desaparece. */
const NOM = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto'];
const nomina: unknown[][] = [['Fecha de Pago', 'Colaborador', 'Concepto', 'Monto', 'Moneda']];
for (let m = 1; m <= 8; m++) {
  for (const [quien, sueldo] of [
    ['Ana Lucía Morales', 4200],
    ['Rodrigo Pérez', 3800],
  ] as [string, number][]) {
    anota('opex', sueldo);
    nomina.push([`15 de ${NOM[m - 1]} de 2026`, quien, 'Sueldo mensual', sueldo, 'GTQ']);
  }
}

/** Compras: fechas MM/DD/YYYY (export en inglés) y montos como TEXTO con símbolo. */
const compras: unknown[][] = [['Fecha', 'Proveedor', 'Categoría', 'Monto', 'Moneda']];
for (let m = 1; m <= 8; m++) {
  const v = 2000 + m * 50;
  anota('cogs', v);
  // Día 14: mayor que 12, así que solo `mdy` lo explica.
  compras.push([
    `${String(m).padStart(2, '0')}/14/2026`,
    'Finca La Esperanza',
    'Café oro',
    `Q ${v.toLocaleString('en-US', { minimumFractionDigits: 2 })}`,
    'GTQ',
  ]);
}

/** Matriz de gastos por mes: la ÚNICA fuente de estos conceptos. Debe despivotarse. */
const MESES_NOM = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto'];
const gastos: unknown[][] = [
  ['Gastos operativos mensuales 2026'],
  [null, 'Concepto', 'Tipo', ...MESES_NOM, 'Total'],
];
for (const [concepto, tipo, base] of [
  ['Alquiler de local y bodega', 'Fijo', 1500],
  ['Energía eléctrica y agua', 'Variable', 430],
  ['Honorarios contables', 'Fijo', 750],
] as [string, string, number][]) {
  const fila: unknown[] = [null, concepto, tipo];
  for (let m = 1; m <= 8; m++) {
    fila.push(base);
    anota('opex', base);
  }
  fila.push(base * 8);
  gastos.push(fila);
}
gastos.push([null, 'TOTAL GASTOS OPERATIVOS', '', ...MESES_NOM.map(() => 2680), 21_440]);

/** Estado de resultados: MISMA forma que la matriz de arriba. NO debe despivotarse. */
const estado: unknown[][] = [
  ['Estado de resultados 2026'],
  [null, 'Concepto', ...MESES_NOM, 'Acumulado'],
  [null, 'Ventas netas', ...MESES_NOM.map(() => 7000), 56_000],
  [null, '(-) Costo de ventas', ...MESES_NOM.map(() => -3150), -25_200],
  [null, 'Utilidad bruta', ...MESES_NOM.map(() => 3850), 30_800],
];

/** Cartera de clientes: NIT + contacto + condiciones. Es catálogo, no ingresos. */
const cartera: unknown[][] = [
  [null, 'Cliente', 'NIT', 'Contacto', 'Teléfono', 'Condiciones', 'Última Compra', 'Saldo'],
  [null, 'Cafetería El Roble', '4521879-3', 'Ana Morales', '5512-8890', '30 días', serial('2026-08-20'), 4335], // prettier-ignore
  [null, 'Bistró La Cuadra', '8834125-6', 'Rodrigo Pérez', '4478-2201', '30 días', serial('2026-08-22'), 2076], // prettier-ignore
  [null, 'Panadería El Molino', '1209774-1', 'Marta Xoc', '5590-4412', '30 días', serial('2026-08-19'), 3408], // prettier-ignore
];

const LIBRO: [string, unknown[][]][] = [
  ['Ventas', ventas],
  ['Resumen_Mensual', resumen],
  ['Nomina', nomina],
  ['Compras', compras],
  ['Gastos_Operativos', gastos],
  ['Estado_Resultados', estado],
  ['Clientes_B2B', cartera],
];

function libro(): XLSX.WorkBook {
  const wb = XLSX.utils.book_new();
  for (const [n, f] of LIBRO) XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(f), n);
  return wb;
}

/* ═══════════════════ EL MODELO DOBLE: ACIERTA SIEMPRE ═══════════════════ */

const VACIO: ColumnMap = {
  date: null, amount: null, currency: null, description: null, counterparty: null,
  product: null, quantity: null, productCategory: null, store: null, dueDate: null,
  costTotal: null, costUnit: null,
}; // prettier-ignore

const norm = (v: unknown) =>
  String(v ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\([^)]*\)/g, ' ')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');

function mapaIdeal(header: unknown[]): ColumnMap {
  const H = header.map(norm);
  const buscar = (...c: string[]) => {
    for (const x of c) {
      const i = H.indexOf(x);
      if (i >= 0) return i;
    }
    return null;
  };
  return {
    ...VACIO,
    date: buscar('fecha', 'fechadepago'),
    amount: buscar('ventaneta', 'monto'),
    currency: buscar('moneda'),
    counterparty: buscar('cliente', 'proveedor', 'colaborador'),
    product: buscar('producto'),
    quantity: buscar('cantidad'),
    productCategory: buscar('categoria', 'concepto'),
    description: buscar('concepto'),
    costTotal: buscar('costototal'),
  };
}

/* ═══════════════════ EL PIPELINE, TAL COMO CORRE EN EL WORKER ═══════════════════ */

interface Corrida {
  totales: { revenue: number; cogs: number; opex: number };
  destino: Map<string, string>;
  marcadas: number;
}

function correrPipeline(wb: XLSX.WorkBook): Corrida {
  const leer = (n: string): unknown[][] =>
    XLSX.utils.sheet_to_json(wb.Sheets[n]!, { header: 1, blankrows: false });

  const fechasDelLibro: unknown[] = [];
  for (const n of wb.SheetNames) {
    for (const f of leer(n).slice(1, 40)) {
      for (const v of f) if (asDate(v) !== null) fechasDelLibro.push(v);
    }
  }

  const conceptosDeMovimientos = new Set<string>();
  for (const n of wb.SheetNames) {
    const crudas = leer(n);
    if (crudas.length < 2) continue;
    const d = crudas.slice(detectarFilaDeEncabezado(crudas));
    if (analizarFormaDeHoja(d).esReporte) continue;
    if (canSkipSheet(d[0] ?? [])) continue;
    if (noPuedeProducirMovimientos(d, asDate, asNumber)) continue;
    for (const f of d.slice(1, 600)) {
      for (const v of f) {
        if (typeof v !== 'string') continue;
        const k = claveDeConceptoAncho(v);
        if (k) conceptosDeMovimientos.add(k);
      }
    }
  }

  const despivotar = (nombre: string, crudas: unknown[][], rows: unknown[][]) =>
    despivotarReporte(rows, {
      anioPorDefecto: inferirAnio({ nombreHoja: nombre, fechasDelLibro }),
      conceptosDeMovimientos,
    });

  /* ── Pasada 1: hojas vivas ── */
  const vivas: { nombre: string; rows: unknown[][]; puedeProducirMovimientos: boolean }[] = [];
  const ordenPorHoja = new Map<string, 'dmy' | 'mdy'>();
  for (const nombre of wb.SheetNames) {
    const crudas = leer(nombre);
    if (crudas.length < 2) continue;
    let desde = crudas.slice(detectarFilaDeEncabezado(crudas));
    if (analizarFormaDeHoja(desde).esReporte) {
      const largo = despivotar(nombre, crudas, desde);
      if (!largo) continue;
      desde = largo.rows;
    }
    if (canSkipSheet(desde[0] ?? [])) continue;
    ordenPorHoja.set(nombre, detectarOrdenDeFecha(desde.slice(1).flat()));
    vivas.push({
      nombre,
      rows: desde,
      puedeProducirMovimientos: !noPuedeProducirMovimientos(desde, asDate, asNumber),
    });
  }
  const dup = detectarDetalleDuplicado(vivas);
  const esq = analizarEsquema(vivas);
  const esLibro = new Map(vivas.map((h) => [h.nombre, pareceLibroDeMovimientos(h.rows[0] ?? [])]));
  const entidades = new Set([...esq.entidades].filter((n) => !esLibro.get(n)));

  /* ── Pasada 2: procesar ── */
  const totales = { revenue: 0, cogs: 0, opex: 0 };
  const destino = new Map<string, string>();
  let marcadas = 0;

  for (const nombre of wb.SheetNames) {
    const crudas = leer(nombre);
    if (crudas.length < 2) {
      destino.set(nombre, 'vacia');
      continue;
    }
    let rows = crudas.slice(detectarFilaDeEncabezado(crudas));
    let despivotada = false;
    if (analizarFormaDeHoja(rows).esReporte) {
      const largo = despivotar(nombre, crudas, rows);
      if (!largo) {
        destino.set(nombre, 'descartada:reporte');
        continue;
      }
      rows = largo.rows;
      despivotada = true;
    }
    if (dup.get(nombre)) {
      destino.set(nombre, 'descartada:duplica');
      continue;
    }
    if (entidades.has(nombre) || firmaDeCatalogo(rows[0] ?? []) === 'existencias') {
      destino.set(nombre, 'inventario');
      continue;
    }
    if (canSkipSheet(rows[0] ?? [])) {
      destino.set(nombre, `descartada:catalogo:${firmaDeCatalogo(rows[0] ?? [])}`);
      continue;
    }
    if (noPuedeProducirMovimientos(rows, asDate, asNumber)) {
      destino.set(nombre, 'descartada:sin-fecha-o-monto');
      continue;
    }

    const header = rows[0] ?? [];
    const datos = rows.slice(1);
    const columns = mapaIdeal(header);
    const orden = ordenPorHoja.get(nombre);
    const n = norm(nombre);
    const tipo: 'revenue' | 'cogs' | 'opex' = n.includes('venta')
      ? 'revenue'
      : n.includes('compra')
        ? 'cogs'
        : 'opex';

    let movimientos = 0;
    for (let i = 0; i < datos.length; i++) {
      const fila = datos[i]!;
      // El modelo doble reconoce un renglón de TOTAL y lo declara `skip`.
      if (fila.some((c) => typeof c === 'string' && /^\s*TOTAL/i.test(c))) continue;

      const verdict: RowVerdict = {
        i,
        targetEntity: 'transaction',
        type: tipo,
        category: String(fila[columns.productCategory ?? -1] ?? 'general'),
        confidence: 0.95,
      };
      const payload = assemblePayload({
        verdict,
        row: fila,
        columns,
        baseCurrency: 'GTQ',
        ordenDeFecha: orden,
      }) as { date: string; originalAmount: number };

      if (evaluateFlagReason({ targetEntity: 'transaction', payload, confidence: 0.95 })) {
        marcadas++;
        continue;
      }
      totales[tipo] = r2(totales[tipo] + payload.originalAmount);
      movimientos++;

      // La venta con costo en la misma fila desdobla en una segunda transacción `cogs`.
      if (tipo === 'revenue' && columns.costTotal !== null) {
        const c = asNumber(fila[columns.costTotal]);
        if (c !== null && c !== 0) totales.cogs = r2(totales.cogs + Math.abs(c));
      }
    }
    destino.set(nombre, `movimientos:${movimientos}${despivotada ? ':despivotada' : ''}`);
  }

  return { totales, destino, marcadas };
}

/* ═══════════════════════════════ LAS AFIRMACIONES ═══════════════════════════════ */

describe('el dashboard cuadra contra la verdad del archivo', () => {
  const corrida = correrPipeline(libro());

  test('los ingresos son los del archivo, sin duplicar ni perder', () => {
    expect(corrida.totales.revenue).toBeCloseTo(verdad.revenue, 2);
  });

  test('el costo de ventas suma la hoja de compras Y el costo de la línea de venta', () => {
    expect(corrida.totales.cogs).toBeCloseTo(verdad.cogs, 2);
  });

  test('los gastos operativos NO son cero', () => {
    /*
     * La afirmación que más veces falló en producción. Un dashboard con GTQ 0,00 de gastos no
     * es "un dato que falta": deja el resultado del período INFLADO, o sea que la cifra que sí
     * se muestra está mal.
     */
    expect(corrida.totales.opex).toBeGreaterThan(0);
    expect(corrida.totales.opex).toBeCloseTo(verdad.opex, 2);
  });

  test('ninguna fila queda marcada: el archivo se entiende entero', () => {
    expect(corrida.marcadas).toBe(0);
  });
});

describe('cada hoja termina donde debe', () => {
  const { destino } = correrPipeline(libro());

  test('las hojas de movimientos se procesan', () => {
    expect(destino.get('Ventas')).toMatch(/^movimientos:48$/);
    expect(destino.get('Compras')).toMatch(/^movimientos:8$/);
    expect(destino.get('Nomina')).toMatch(/^movimientos:16$/);
  });

  test('la matriz de gastos se despivota en vez de descartarse', () => {
    expect(destino.get('Gastos_Operativos')).toBe('movimientos:24:despivotada');
  });

  test('el estado de resultados NO se despivota', () => {
    expect(destino.get('Estado_Resultados')).toBe('descartada:reporte');
  });

  test('el resumen mensual con fecha serial no se procesa', () => {
    // Si se procesara, la facturación del cliente se contaría dos veces.
    expect(destino.get('Resumen_Mensual')).toMatch(/^descartada:/);
  });

  test('la cartera de clientes es catálogo, no ingresos', () => {
    // El bug de KapePrueba: Q 13.362,75 de saldo por cobrar presentados como ingresos.
    expect(destino.get('Clientes_B2B')).toBe('descartada:catalogo:contactos');
  });
});

describe('cada trampa por separado', () => {
  /**
   * Quitar una hoja del libro cambia lo que las demás pueden inferir, así que cada caso se
   * mide sobre el libro COMPLETO. Lo que se afirma acá es la contribución de cada hoja.
   */
  const { totales } = correrPipeline(libro());

  test('la nómina en español aporta sus 16 sueldos', () => {
    // Sin parsear "15 de enero de 2026" la hoja entera desaparecía: 0 en vez de 64.000.
    expect(totales.opex).toBeGreaterThanOrEqual(4200 * 8 + 3800 * 8);
  });

  test('las compras con fecha MM/DD/YYYY no se pierden', () => {
    // Día 14 en todas: con `dmy` da mes 14 → null → la hoja se descarta entera.
    let esperado = 0;
    for (let m = 1; m <= 8; m++) esperado += 2000 + m * 50;
    expect(totales.cogs).toBeGreaterThanOrEqual(esperado);
  });
});
