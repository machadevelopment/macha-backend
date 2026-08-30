import * as XLSX from 'xlsx';
import { detectarFilaDeEncabezado } from '../sheet-header';
import { analizarFormaDeHoja } from '../sheet-shape';
import { detectarDetalleDuplicado } from '../sheet-duplication';
import {
  canSkipSheet,
  firmaDeCatalogo,
  noPuedeProducirMovimientos,
  pareceLibroDeMovimientos,
} from '../sheet-classifier';
import { analizarEsquema } from '../sheet-relations';
import { asDate, asNumber, detectarOrdenDeFecha, type ColumnMap } from '../row-assembly';
import { construirFilas, type VeredictoCrudo } from '../anthropic';
import { evaluateFlagReason } from '../staging-rules';
import { claveDeConceptoAncho, despivotarReporte, inferirAnio } from '../sheet-unpivot';

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * EL PIPELINE COMPLETO CON UN MODELO QUE ACIERTA SIEMPRE
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *
 * Corre los MISMOS pasos que `excel-ingest.ts`: detección de encabezado, forma de hoja,
 * despivotado, pre-filtro de catálogo, dedup cabecera/detalle, esquema del libro, orden de
 * fecha, `construirFilas` (el ensamblado real, con sus derivaciones) y `staging-rules`.
 *
 * Lo ÚNICO sustituido es la llamada a Claude: en su lugar hay un clasificador determinista que
 * el libro de prueba provee y que acierta por construcción. Eso no es una simplificación, es
 * el punto entero — **aísla la variable**. Si con un modelo perfecto la cifra del dashboard
 * sale mal, el defecto está en el código, que es lo que resultó ser en los siete reportes de
 * ingesta que llegaron de clientes.
 *
 * El total que devuelve es el del DASHBOARD, no el de una etapa intermedia: `rollups.ts` suma
 * `transactions.amount_base` agrupado por tipo, así que acá se suma exactamente eso — las
 * filas `invoice` y `bill` cuentan solo por las transacciones que DERIVAN, nunca por sí
 * mismas.
 */

const r2 = (n: number) => Math.round(n * 100) / 100;

export type Tipo = 'revenue' | 'cogs' | 'opex' | 'other';
export type Verdad = { revenue: number; cogs: number; opex: number };

/** Lo que el modelo diría de una fila. `null` = `skip`: no es un dato, y lo dice explícito. */
export type Veredicto = {
  e: 'transaction' | 'invoice' | 'bill';
  t: Tipo;
  c?: string;
  cf?: number;
} | null;

export interface ContextoDeFila {
  hoja: string;
  header: unknown[];
  fila: unknown[];
  columns: ColumnMap;
  /** Índice dentro de las filas de datos (sin el encabezado). */
  i: number;
}

export type Clasificador = (ctx: ContextoDeFila) => Veredicto;

export interface LibroHostil {
  archivo: string;
  titulo: string;
  /** Qué rompe este libro. Sale en el reporte cuando falla. */
  rompe: string;
  hojas: [string, unknown[][]][];
  verdad: Verdad;
  clasificar: Clasificador;
  /** Dónde debe terminar cada hoja. Se afirma solo lo que se nombra acá. */
  destinos?: Record<string, string | RegExp>;
  /** Cuántas filas deben ir a revisión interna. Por defecto, ninguna. */
  marcadas?: number;
  /** Moneda base de la empresa. */
  base?: string;
  /** Tasas contra la base, para poder afirmar `amount_base`. */
  tasas?: Record<string, number>;
}

export interface Corrida {
  totales: Verdad;
  destino: Map<string, string>;
  marcadas: number;
  motivos: Map<string, number>;
  /** Filas de ledger producidas por entidad, para ver una expansión inesperada. */
  entidades: { transaction: number; invoice: number; bill: number };
}

/* ═══════════════════ EL MAPA DE COLUMNAS QUE DARÍA UN BUEN MODELO ═══════════════════ */

const VACIO: ColumnMap = {
  date: null, amount: null, currency: null, description: null, counterparty: null,
  product: null, quantity: null, productCategory: null, store: null, dueDate: null,
  costTotal: null, costUnit: null,
}; // prettier-ignore

export const norm = (v: unknown) =>
  String(v ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\([^)]*\)/g, ' ')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');

/**
 * Distancia de edición acotada a 2. Se usa para que el doble tolere TYPOS en los encabezados
 * (`Fehca`, `Montoo`, `Clietne`), que es lo que un modelo de verdad hace sin esfuerzo.
 *
 * Importa que el doble los tolere: si no, un typo se vería como "el pipeline perdió la hoja"
 * cuando en realidad el fallo sería del doble, y el test acusaría al código equivocado.
 */
function cerca(a: string, b: string): boolean {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 2) return false;
  const d: number[][] = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i++) d[i]![0] = i;
  for (let j = 0; j <= b.length; j++) d[0]![j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const c = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + c);
      // Damerau: una TRANSPOSICIÓN cuesta 1, no 2. Es el typo más común de todos
      // (`Fehca` por `Fecha`) y con Levenshtein puro quedaba a distancia 2.
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i]![j] = Math.min(d[i]![j]!, d[i - 2]![j - 2]! + 1);
      }
    }
  }
  // Un umbral de 2 sobre palabras cortas confundiría "mes" con "mas"; se escala con el largo.
  return d[a.length]![b.length]! <= (Math.min(a.length, b.length) >= 6 ? 2 : 1);
}

const SINONIMOS: Record<keyof ColumnMap, string[]> = {
  /*
   * Incluyen lo que un modelo REAL mapearía, no solo lo correcto: `ultimacompra` como fecha y
   * `saldoporcobrar` como monto es exactamente lo que Claude hizo con la cartera de clientes
   * de KapePrueba. Si el doble fuera más torpe que el modelo de verdad, este test se pondría
   * verde por una incapacidad del doble y el bug seguiría vivo en producción.
   */
  date: ['fecha', 'fechadepago', 'fechaemision', 'fechadeemision', 'fechafactura', 'fechamovimiento', 'dia', 'date', 'ultimacompra', 'ultimavenopta'], // prettier-ignore
  amount: ['monto', 'ventaneta', 'total', 'importe', 'valor', 'montoq', 'amount', 'montototal', 'preciototal', 'debe', 'saldo', 'saldoxcobrar', 'saldoporcobrar', 'ventanetaacumulada'], // prettier-ignore
  currency: ['moneda', 'divisa', 'currency'],
  description: ['descripcion', 'concepto', 'detalle', 'glosa'],
  counterparty: ['cliente', 'proveedor', 'colaborador', 'contraparte', 'razonsocial', 'empleado'], // prettier-ignore
  product: ['producto', 'articulo', 'item', 'sku', 'descripcionproducto'],
  quantity: ['cantidad', 'unidades', 'qty', 'cant'],
  productCategory: ['categoria', 'rubro', 'clasificacion', 'tipodegasto'],
  store: ['tienda', 'sucursal', 'local'],
  dueDate: ['fechavencimiento', 'vencimiento', 'fechalimite'],
  costTotal: ['costototal', 'costodeventa', 'costo'],
  costUnit: ['costounitario', 'costounit'],
};

/**
 * El ORDEN importa: `costo` es sinónimo de `costTotal` y `monto` de `amount`, pero
 * `costo total` está cerca de las dos por edición. Se resuelve por campos en este orden y una
 * columna ya tomada no se reasigna, así que el más específico gana.
 */
const ORDEN: (keyof ColumnMap)[] = [
  'date', 'dueDate', 'costTotal', 'costUnit', 'currency', 'quantity',
  'productCategory', 'counterparty', 'product', 'store', 'description', 'amount',
]; // prettier-ignore

export function mapaIdeal(header: unknown[], muestras: unknown[][] = []): ColumnMap {
  const H = header.map(norm);
  const mapa: ColumnMap = { ...VACIO };
  const tomadas = new Set<number>();

  /**
   * Magnitud típica de una columna. Sirve para desempatar cuando DOS columnas se llaman igual,
   * que es lo que pasa en un archivo hecho a mano: `Monto` para la cantidad y `Monto` para el
   * importe. El modelo de verdad recibe filas de muestra en el prompt y las distingue mirando
   * los valores; un doble que se quedara con la primera coincidencia estaría siendo PEOR que
   * el modelo y le achacaría al pipeline un fallo que no es suyo.
   */
  const magnitud = (col: number): number => {
    const vals = muestras
      .map((f) => asNumber(f[col]))
      .filter((n): n is number => n !== null)
      .map(Math.abs)
      .sort((a, b) => a - b);
    return vals.length === 0 ? -1 : vals[Math.floor(vals.length / 2)]!;
  };

  for (const campo of ORDEN) {
    const candidatos = SINONIMOS[campo];
    let elegida: number | null = null;
    // Primero exacto en todo el encabezado; solo si nadie coincide, se acepta un typo.
    for (const pase of [0, 1]) {
      if (elegida !== null) break;
      const coincidencias: number[] = [];
      for (let i = 0; i < H.length; i++) {
        const h = H[i];
        if (h === undefined || h === '' || tomadas.has(i)) continue;
        if (candidatos.some((c) => (pase === 0 ? h === c : cerca(h, c)))) coincidencias.push(i);
      }
      if (coincidencias.length === 0) continue;
      elegida =
        campo === 'amount' && coincidencias.length > 1
          ? coincidencias.reduce((a, b) => (magnitud(b) > magnitud(a) ? b : a))
          : coincidencias[0]!;
    }
    if (elegida !== null) {
      mapa[campo] = elegida;
      tomadas.add(elegida);
    }
  }
  return mapa;
}

/* ═══════════════════════════════ EL PIPELINE ═══════════════════════════════ */

export function correrPipeline(libro: LibroHostil): Corrida {
  const wb = aWorkbook(libro);
  const base = libro.base ?? 'GTQ';
  const tasas = { [base]: 1, ...(libro.tasas ?? {}) };

  const leer = (n: string): unknown[][] =>
    XLSX.utils.sheet_to_json(wb.Sheets[n]!, { header: 1, blankrows: false });

  const fechasDelLibro: unknown[] = [];
  for (const n of wb.SheetNames) {
    for (const f of leer(n).slice(1, 40)) {
      for (const v of f) if (asDate(v) !== null) fechasDelLibro.push(v);
    }
  }

  /* ── Conceptos por hoja, para la guarda 4 del despivotado ── */
  const conceptosPorHoja = new Map<string, Set<string>>();
  for (const n of wb.SheetNames) {
    const crudas = leer(n);
    if (crudas.length < 2) continue;
    const d = crudas.slice(detectarFilaDeEncabezado(crudas));
    if (analizarFormaDeHoja(d).esReporte) continue;
    if (canSkipSheet(d[0] ?? [])) continue;
    if (noPuedeProducirMovimientos(d, asDate, asNumber)) continue;
    const propios = new Set<string>();
    for (const f of d.slice(1, 600)) {
      for (const v of f) {
        if (typeof v !== 'string') continue;
        const k = claveDeConceptoAncho(v);
        if (k) propios.add(k);
      }
    }
    conceptosPorHoja.set(n, propios);
  }
  const conceptosAjenosA = (hoja: string): Set<string> => {
    const union = new Set<string>();
    for (const [n, propios] of conceptosPorHoja) {
      if (n === hoja) continue;
      for (const c of propios) union.add(c);
    }
    return union;
  };
  const despivotar = (nombre: string, rows: unknown[][]) =>
    despivotarReporte(rows, {
      anioPorDefecto: inferirAnio({ nombreHoja: nombre, fechasDelLibro }),
      conceptosDeMovimientos: conceptosAjenosA(nombre),
    });

  /* ── Pasada 1: qué hojas siguen vivas y qué dice el esquema del libro ── */
  const conceptosDe = (largas: unknown[][]): ReadonlySet<string> =>
    new Set(
      largas
        .slice(1)
        .map((f) => claveDeConceptoAncho(f[1]))
        .filter((c) => c !== ''),
    );

  const vivas: {
    nombre: string;
    rows: unknown[][];
    puedeProducirMovimientos: boolean;
    conceptos?: ReadonlySet<string>;
  }[] = [];
  const ordenPorHoja = new Map<string, 'dmy' | 'mdy'>();
  for (const nombre of wb.SheetNames) {
    const crudas = leer(nombre);
    if (crudas.length < 2) continue;
    let desde = crudas.slice(detectarFilaDeEncabezado(crudas));
    let conceptos: ReadonlySet<string> | undefined;
    const largo = despivotar(nombre, desde);
    if (largo) {
      desde = largo.rows;
      conceptos = conceptosDe(largo.rows);
    } else if (analizarFormaDeHoja(desde).esReporte) {
      continue;
    }
    if (canSkipSheet(desde[0] ?? [])) continue;
    ordenPorHoja.set(nombre, detectarOrdenDeFecha(desde.slice(1).flat()));
    vivas.push({
      nombre,
      rows: desde,
      ...(conceptos ? { conceptos } : {}),
      puedeProducirMovimientos: !noPuedeProducirMovimientos(desde, asDate, asNumber),
    });
  }
  const dup = detectarDetalleDuplicado(vivas);
  const esq = analizarEsquema(vivas);
  const esLibro = new Map(vivas.map((h) => [h.nombre, pareceLibroDeMovimientos(h.rows[0] ?? [])]));
  const entidades = new Set([...esq.entidades].filter((n) => !esLibro.get(n)));
  /*
   * El MISMO predicado del worker (`excel-ingest.ts`): una hoja registra un hecho que ya está
   * contado en otra si apunta a una hoja que PRODUCE movimientos. Apuntar a un catálogo no
   * cuenta — que una venta nombre un vehículo no significa que el ingreso esté registrado.
   */
  const yaRegistradaEnOtraHoja = (hoja: string): boolean =>
    esq.referencias.some((r) => r.desde === hoja && !entidades.has(r.hacia));

  /* ── Pasada 2: procesar ── */
  const totales: Verdad = { revenue: 0, cogs: 0, opex: 0 };
  const destino = new Map<string, string>();
  const motivos = new Map<string, number>();
  const cuenta = { transaction: 0, invoice: 0, bill: 0 };
  let marcadas = 0;

  for (const nombre of wb.SheetNames) {
    const crudas = leer(nombre);
    if (crudas.length < 2) {
      destino.set(nombre, 'vacia');
      continue;
    }
    let rows = crudas.slice(detectarFilaDeEncabezado(crudas));
    let despivotada = false;
    const largo = despivotar(nombre, rows);
    if (largo) {
      rows = largo.rows;
      despivotada = true;
    } else if (analizarFormaDeHoja(rows).esReporte) {
      destino.set(nombre, 'descartada:reporte');
      continue;
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
    const columns = mapaIdeal(header, datos.slice(0, 40));
    const orden = ordenPorHoja.get(nombre);

    /* El modelo doble opina de cada fila. */
    const porIndice = new Map<number, VeredictoCrudo>();
    for (let i = 0; i < datos.length; i++) {
      const v = libro.clasificar({ hoja: nombre, header, fila: datos[i]!, columns, i });
      porIndice.set(i, {
        i,
        e: v === null ? 'skip' : v.e,
        t: v === null ? 'other' : v.t,
        c: v === null ? null : (v.c ?? 'general'),
        cf: v === null ? 1 : (v.cf ?? 0.95),
      });
    }

    const clasificadas = construirFilas(
      porIndice,
      {
        rows: datos,
        baseCurrency: base,
        ventaYaRegistradaEnOtraHoja: yaRegistradaEnOtraHoja(nombre),
        compraYaRegistradaEnOtraHoja: yaRegistradaEnOtraHoja(nombre),
        ...(orden ? { ordenDeFecha: orden } : {}),
      },
      columns,
    );

    let movimientos = 0;
    for (const fila of clasificadas) {
      cuenta[fila.targetEntity]++;
      const motivo = evaluateFlagReason(fila);
      if (motivo) {
        marcadas++;
        motivos.set(motivo, (motivos.get(motivo) ?? 0) + 1);
        continue;
      }
      if (fila.targetEntity !== 'transaction') continue;
      const p = fila.payload as { type: Tipo; originalAmount: number; originalCurrency: string };
      if (p.type === 'other') continue;
      const tasa = tasas[p.originalCurrency] ?? 1;
      totales[p.type] = r2(totales[p.type] + p.originalAmount * tasa);
      movimientos++;
    }
    destino.set(nombre, `movimientos:${movimientos}${despivotada ? ':despivotada' : ''}`);
  }

  return { totales, destino, marcadas, motivos, entidades: cuenta };
}

export function aWorkbook(libro: LibroHostil): XLSX.WorkBook {
  const wb = XLSX.utils.book_new();
  for (const [n, filas] of libro.hojas) {
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(filas), n.slice(0, 31));
  }
  return wb;
}

/** Serial de Excel (época 1899-12-30), que es como vienen las fechas de un .xlsx real. */
export const serial = (iso: string) =>
  Math.round((Date.parse(`${iso}T00:00:00Z`) - Date.UTC(1899, 11, 30)) / 86_400_000);

/* ═══════════════════════════════════════════════════════════════════════════════════════════
 * EL DOBLE DE MODELO: BUENO CLASIFICANDO, IGNORANTE DEL LIBRO
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *
 * Un doble omnisciente —que supiera qué hoja NO hay que procesar— taparía justo lo que hay que
 * medir. El fallo de KapePrueba fue exactamente ese: una cartera de clientes llegó al modelo,
 * y el modelo hizo lo ÚNICO que podía con ella — leyó `Última compra` como fecha y `Saldo por
 * cobrar` como monto, y Q 13.362,75 de cobranza pendiente aparecieron como ingresos.
 *
 * Así que este doble se parece a eso: clasifica MUY bien lo que se le da (tipo, renglones de
 * total, filas vacías), y no sabe nada de lo que no se le dio. Una hoja que el pipeline
 * debería haber filtrado y no filtró produce cifras plausibles y equivocadas, igual que en
 * producción, y el total del dashboard lo delata.
 */
export function dobleDeModelo(config: {
  /** Tipo por hoja, para las hojas que SÍ deben procesarse. */
  tipos?: Record<string, Tipo>;
  /** Entidad por hoja: factura emitida, factura recibida o transacción. */
  entidades?: Record<string, 'transaction' | 'invoice' | 'bill'>;
  /** Confianza por hoja, para provocar revisión interna a propósito. */
  confianza?: Record<string, number>;
}): Clasificador {
  const { tipos = {}, entidades = {}, confianza = {} } = config;
  return ({ hoja, fila, columns }) => {
    const texto = fila.filter((c) => typeof c === 'string') as string[];
    if (texto.some((c) => /^\s*(total|totales|sub\s*total|suma|gran\s+total)\b/i.test(c))) {
      return null;
    }
    const monto = columns.amount === null ? null : asNumber(fila[columns.amount]);
    const fecha = columns.date === null ? null : asDate(fila[columns.date]);
    // Sin ninguna de las dos no hay hecho que registrar; el modelo lo declara `skip`.
    if (monto === null && fecha === null) return null;

    const declarado = tipos[hoja];
    /*
     * El FALLBACK es lo que hace útil a este doble: una hoja que el pipeline no filtró y que
     * el libro nunca declaró se clasifica por la FORMA de la fila, que es todo lo que un
     * modelo sin contexto tiene. Un monto positivo con contraparte parece una venta.
     */
    const tipo: Tipo =
      declarado ??
      (monto !== null && monto < 0 ? 'opex' : columns.counterparty !== null ? 'revenue' : 'opex');

    return {
      e: entidades[hoja] ?? 'transaction',
      t: tipo,
      c: tipo === 'revenue' ? 'ventas' : 'general',
      cf: confianza[hoja] ?? 0.95,
    };
  };
}
