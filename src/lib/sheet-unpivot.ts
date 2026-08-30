/**
 * Convierte un REPORTE ANCHO (una fila por concepto, una columna por mes) en movimientos.
 *
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * POR QUÉ EXISTE: `sheet-shape` acierta al decir "esto no es una tabla" y aun así se pierde
 * plata real
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *
 * `analizarFormaDeHoja` reconoce el reporte ancho y la hoja se DESCARTA. Para un
 * `Estado_Resultados` eso es correcto —es un derivado de otras hojas— pero para la matriz de
 * gastos operativos no lo es: en el libro de una PYME esa hoja **es la única fuente de sus
 * gastos**, y no hay ninguna otra hoja de donde sacarlos.
 *
 * Medido sobre el archivo de demo de KapePrueba (2026-08-28) y sobre el archivo hostil
 * (2026-08-30): el dashboard mostraba `GTQ 0.00` en Gastos Operativos con Q 57.111 y Q 62.486
 * respectivamente en el archivo. El cliente ve utilidad neta = utilidad bruta, o sea que el
 * producto le dice que operar su negocio no cuesta nada.
 *
 * Descartar la hoja tampoco es "conservador": deja el resultado del período INFLADO. No es que
 * falte un dato, es que la cifra que sí se muestra está mal.
 *
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * EL RIESGO REAL, Y POR QUÉ LAS GUARDAS SON UNA LISTA BLANCA
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *
 * `Estado_Resultados` y `Flujo_Caja` tienen EXACTAMENTE la misma forma que la matriz de
 * gastos: concepto a la izquierda, un mes por columna. Despivotarlos duplicaría los ingresos
 * y el costo del cliente —que ya vienen de las hojas de detalle— y encima sumaría saldos de
 * caja como si fueran movimientos.
 *
 * O sea que este módulo tiene el mayor potencial de daño de todo el pipeline. Por eso NO
 * decide "esto parece seguro": exige que se cumplan TODAS las condiciones de abajo y, ante
 * cualquier duda, devuelve `null` y la hoja sigue el camino que ya seguía (descartarse). El
 * peor caso de este módulo es no mejorar nada; nunca es contar de más.
 *
 * ═══ LO QUE SEPARA UNA MATRIZ DE GASTOS DE UN ESTADO DE RESULTADOS ═══
 *
 * No es la forma —es idéntica— sino la NATURALEZA de sus renglones:
 *
 *   · Una matriz de gastos son PARES: alquiler, sueldos, luz, internet. Ninguno se calcula a
 *     partir de los otros, todos son del mismo signo, y ninguno es un concepto contable
 *     agregado.
 *   · Un estado financiero son LÍNEAS DERIVADAS: "Utilidad bruta" es una resta de las dos de
 *     arriba, "Saldo final" arrastra el saldo inicial. Mezclan signos (el costo va en
 *     negativo o entre paréntesis) y usan vocabulario de agregado — utilidad, saldo, margen,
 *     resultado, total.
 *
 * Las tres señales se exigen JUNTAS porque cada una sola tiene un contraejemplo: hay estados
 * escritos todo en positivo (falla el signo), y una matriz de gastos puede traer una fila
 * "Total" (falla el vocabulario si se mira sin excluirla).
 */
import { asDate, asNumber } from './row-assembly';
import { pareceNombreDePeriodo } from './sheet-shape';

const MESES_ES: Record<string, number> = {
  enero: 1, ene: 1, febrero: 2, feb: 2, marzo: 3, mar: 3, abril: 4, abr: 4,
  mayo: 5, may: 5, junio: 6, jun: 6, julio: 7, jul: 7, agosto: 8, ago: 8,
  septiembre: 9, setiembre: 9, sep: 9, sept: 9, set: 9,
  octubre: 10, oct: 10, noviembre: 11, nov: 11, diciembre: 12, dic: 12,
  january: 1, jan: 1, february: 2, march: 3, april: 4, apr: 4, june: 6, july: 7,
  august: 8, aug: 8, september: 9, october: 10, november: 11, december: 12, dec: 12,
}; // prettier-ignore

const sinAcentos = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

/**
 * Qué mes (y qué año, si lo dice) nombra este encabezado de columna.
 *
 * Acepta `Enero`, `ene-26`, `Enero 2026`, `2026-01`, `01/2026`. El año es opcional: una matriz
 * de gastos suele escribir solo el nombre del mes y el año vive en el título de la hoja.
 */
export function mesDeEncabezado(nombre: unknown): { mes: number; anio: number | null } | null {
  if (typeof nombre !== 'string') return null;
  const t = sinAcentos(nombre).replace(/\s+/g, ' ');
  if (t === '') return null;

  // `2026-01` · `01/2026`
  let m = /^(\d{4})[-/](\d{1,2})$/.exec(t);
  if (m) {
    const mes = Number(m[2]);
    return mes >= 1 && mes <= 12 ? { mes, anio: Number(m[1]) } : null;
  }
  m = /^(\d{1,2})[-/](\d{4})$/.exec(t);
  if (m) {
    const mes = Number(m[1]);
    return mes >= 1 && mes <= 12 ? { mes, anio: Number(m[2]) } : null;
  }

  // `enero` · `ene-26` · `enero 2026` · `ene.2026`
  m = /^([a-z]{3,10})\.?[\s./-]*(\d{2,4})?$/.exec(t);
  if (!m) return null;
  const mes = MESES_ES[m[1]!];
  if (!mes) return null;
  if (m[2] === undefined) return { mes, anio: null };
  let anio = Number(m[2]);
  if (anio < 100) anio += 2000;
  return anio >= 1990 && anio <= 2100 ? { mes, anio } : null;
}

/*
 * Vocabulario de LÍNEA DE ESTADO FINANCIERO: conceptos que son el RESULTADO de una cuenta, no
 * una cuenta.
 *
 * Se compara por inclusión de palabra sobre el texto sin acentos, porque los archivos reales
 * los escriben con adornos: `(-) Costo de ventas`, `= Utilidad bruta`, `TOTAL GASTOS`.
 *
 * La lista es de AGREGADOS, no de rubros. `alquiler`, `sueldos` o `publicidad` son cuentas y
 * no están; `utilidad`, `saldo` y `margen` no son cuentas de ninguna PYME, son renglones
 * calculados. Esa distinción es la que hace que la lista no crezca sin fin: el vocabulario
 * contable de los agregados es cerrado, el de los rubros no.
 */
const PALABRAS_DE_AGREGADO = [
  'utilidad', 'perdida', 'ganancia', 'resultado', 'margen', 'ebitda', 'saldo',
  'subtotal', 'flujo de caja', 'flujo neto', 'efectivo neto', 'punto de equilibrio',
  'ventas netas', 'venta neta', 'ingresos totales', 'ingreso total',
  'costo de ventas', 'costo de venta', 'cogs',
  'gross profit', 'net income', 'net profit', 'total revenue', 'cost of goods',
  'ending balance', 'opening balance', 'cash flow',
]; // prettier-ignore

/** Un renglón de TOTAL. Se excluye del despivotado, no descalifica a la hoja. */
export function esRenglonDeTotal(etiqueta: string): boolean {
  const t = sinAcentos(etiqueta);
  return /^[^a-z0-9]*(total|totales|suma|sumatoria|gran total|acumulado)\b/.test(t);
}

function esLineaDeEstado(etiqueta: string): boolean {
  const t = sinAcentos(etiqueta);
  return PALABRAS_DE_AGREGADO.some((p) => t.includes(p));
}

/**
 * Normaliza un concepto para compararlo entre hojas: sin acentos, sin puntuación, minúsculas.
 *
 * Es la misma idea que `claveDeConcepto` del diccionario de categorías, y por el mismo motivo:
 * "Renta de Local" y "renta de local" son el mismo rubro, y compararlos crudos diría que no.
 */
export function claveDeConceptoAncho(v: unknown): string {
  return String(v ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export interface ReporteDespivotado {
  /** Formato largo con encabezado en la posición 0: `Fecha · Concepto · [Grupo] · Monto`. */
  rows: unknown[][];
  /** Cuántas filas de concepto se leyeron (sin la de total). */
  conceptos: number;
  /** Cuántas columnas de mes se reconocieron. */
  periodos: number;
  /** En lenguaje del cliente, para el resumen de la carga. */
  motivo: string;
}

/** Mínimo de columnas de mes para afirmar que la hoja es una matriz por período. */
const MIN_PERIODOS = 3;

/**
 * Despivota, o `null` si no se puede afirmar que sea seguro.
 *
 * `anioPorDefecto` se usa solo cuando los encabezados de mes no traen año — lo resuelve el
 * llamador mirando el título de la hoja y el resto del libro, porque acá no se ve.
 */
export function despivotarReporte(
  rows: unknown[][],
  opciones: {
    anioPorDefecto: number;
    titulo?: string;
    /**
     * Texto que ya aparece en las hojas del libro que SÍ producen movimientos, normalizado
     * con `claveDeConceptoAncho`. Ver la cuarta guarda.
     */
    conceptosDeMovimientos?: ReadonlySet<string>;
  },
): ReporteDespivotado | null {
  const encabezado = rows[0] ?? [];
  const datos = rows.slice(1);
  if (datos.length === 0) return null;

  /* ── 1. Las columnas que son meses ── */
  const columnasDeMes: { i: number; mes: number; anio: number }[] = [];
  for (let i = 0; i < encabezado.length; i++) {
    const m = mesDeEncabezado(encabezado[i]);
    if (m) columnasDeMes.push({ i, mes: m.mes, anio: m.anio ?? opciones.anioPorDefecto });
  }
  if (columnasDeMes.length < MIN_PERIODOS) return null;

  /*
   * Un mes repetido significa dos bloques distintos a lo ancho (`Enero Costo`, `Enero Venta`):
   * ahí una celda no basta para saber QUÉ es ese número, y despivotar mezclaría conceptos.
   */
  const clavesDeMes = new Set(columnasDeMes.map((c) => `${c.anio}-${c.mes}`));
  if (clavesDeMes.size !== columnasDeMes.length) return null;

  /* ── 2. La columna de CONCEPTO: la primera de texto que no sea un mes ── */
  const indicesDeMes = new Set(columnasDeMes.map((c) => c.i));
  let colConcepto = -1;
  for (let i = 0; i < Math.max(encabezado.length, 4); i++) {
    if (indicesDeMes.has(i)) continue;
    const conTexto = datos.filter((f) => {
      const v = f[i];
      return typeof v === 'string' && v.trim() !== '' && asNumber(v) === null;
    }).length;
    if (conTexto >= Math.max(2, datos.length * 0.6)) {
      colConcepto = i;
      break;
    }
  }
  if (colConcepto === -1) return null;

  /*
   * Una segunda columna de texto (`Tipo`: Fijo/Variable) se conserva como GRUPO. No es
   * decorativa: es lo que deja al cliente ver sus gastos fijos aparte de los variables, que es
   * justo para lo que tenía esa columna en su archivo.
   */
  let colGrupo = -1;
  for (let i = 0; i < encabezado.length; i++) {
    if (i === colConcepto || indicesDeMes.has(i)) continue;
    if (i > colConcepto + 2) break;
    const conTexto = datos.filter((f) => {
      const v = f[i];
      return typeof v === 'string' && v.trim() !== '' && asNumber(v) === null;
    }).length;
    if (conTexto >= datos.length * 0.6) {
      colGrupo = i;
      break;
    }
  }

  /* ── 3. LAS GUARDAS. Cualquiera que falle deja la hoja como estaba. ── */
  const utiles: { etiqueta: string; grupo: string | null; fila: unknown[] }[] = [];
  let huboNegativo = false;

  for (const fila of datos) {
    const etiqueta = String(fila[colConcepto] ?? '').trim();
    if (etiqueta === '') continue;

    const valores = columnasDeMes.map((c) => asNumber(fila[c.i])).filter((n): n is number => n !== null); // prettier-ignore
    if (valores.length === 0) continue;
    if (valores.some((v) => v < 0)) huboNegativo = true;

    // Un renglón de total no descalifica la hoja, pero no se despivota: es la suma de las otras.
    if (esRenglonDeTotal(etiqueta)) continue;

    /*
     * UNA SOLA línea de estado financiero descalifica la hoja entera. No se despivota "lo que
     * se pueda": si la hoja es un estado de resultados, sus renglones de gasto TAMBIÉN están
     * en la hoja de detalle que los origina, y quedarse con ellos contaría de más.
     */
    if (esLineaDeEstado(etiqueta)) return null;

    utiles.push({
      etiqueta,
      grupo: colGrupo >= 0 ? String(fila[colGrupo] ?? '').trim() || null : null,
      fila,
    });
  }

  /*
   * Un signo negativo (o un `(1.234)`) es la firma de un estado financiero: el costo y el gasto
   * se restan del ingreso. Una matriz de gastos no lo necesita — todos sus renglones son de la
   * misma naturaleza, así que todos van en positivo.
   */
  if (huboNegativo) return null;
  if (utiles.length < 2) return null;

  /*
   * ═══════════════════════════════════════════════════════════════════════════════════════
   * CUARTA GUARDA: ¿MIS CONCEPTOS YA SON LAS CATEGORÍAS DE OTRA HOJA?
   * ═══════════════════════════════════════════════════════════════════════════════════════
   *
   * Las tres guardas de arriba miran la hoja SOLA, y hay un caso que ninguna puede ver desde
   * ahí. El archivo real de un restaurante (`02_Restaurante_ElFogon`) trae:
   *
   *     CostosYGastos          180 filas de detalle · columna `Categoria` · Q 1.094.637
   *     ReporteMensualGastos     6 categorías × 12 meses                  · Q 1.082.854
   *                              subtítulo: "Resumen ya consolidado, uso interno de gerencia"
   *
   * La segunda es un CONSOLIDADO de la primera, y es indistinguible de la matriz de gastos
   * legítima de KapePrueba: todos sus valores positivos, ningún renglón con vocabulario de
   * agregado, una fila por rubro. Pasaba las tres guardas y **duplicaba los gastos del
   * restaurante**, que es exactamente el daño que este módulo existe para no causar.
   *
   * `sheet-duplication` tampoco lo atrapa: los dos totales difieren un 1,08 % —el detalle
   * cubre 20 meses y el resumen 12— y el umbral de ese detector es 1 %. Quedó justo afuera.
   *
   * ═══ LA SEÑAL NO ESTÁ EN LA HOJA, ESTÁ EN EL LIBRO ═══
   *
   * La MISMA forma es legítima o duplicada según lo que haya alrededor:
   *
   *   · KapePrueba: sus conceptos (`Alquiler de local y bodega`, `Sueldos`) no aparecen en
   *     ninguna hoja de movimientos. Esa matriz ES la fuente de sus gastos. → se despivota.
   *   · Restaurante: sus conceptos (`Compra de insumos`, `Renta de Local`) son exactamente
   *     los valores de la columna `Categoria` de la hoja de detalle. → es un resumen de ella.
   *
   * Medido sobre los cuatro libros: 100 % de solape en el restaurante, 0 % en los otros tres.
   * La comparación es contra las hojas que **producen movimientos**, no contra todas: contra
   * todas, los conceptos de KapePrueba aparecen en su `Estado_Resultados` y su
   * `Punto_Equilibrio` —que son derivados y no se procesan— y el solape daba 100 % también,
   * o sea que la señal se apagaba entera.
   *
   * El umbral está del lado de NO despivotar, que es la regla de esta casa para este módulo:
   * refusar de más devuelve el comportamiento que ya había; despivotar de más cuenta doble.
   */
  const yaEnElLibro = opciones.conceptosDeMovimientos;
  if (yaEnElLibro && yaEnElLibro.size > 0) {
    const repetidos = utiles.filter((u) => yaEnElLibro.has(claveDeConceptoAncho(u.etiqueta)));
    // Al menos dos, para que una coincidencia suelta no tumbe una hoja legítima.
    if (repetidos.length >= 2 && repetidos.length / utiles.length >= 0.5) return null;
  }

  /* ── 4. El despivotado ── */
  const salida: unknown[][] = [
    colGrupo >= 0 ? ['Fecha', 'Concepto', 'Grupo', 'Monto'] : ['Fecha', 'Concepto', 'Monto'],
  ];
  for (const u of utiles) {
    for (const c of columnasDeMes) {
      const v = asNumber(u.fila[c.i]);
      // El cero no es un movimiento: un mes sin gasto no genera fila.
      if (v === null || v === 0) continue;
      /*
       * Día 1 y no el último del mes: si el mes es el EN CURSO, el último día está en el
       * FUTURO, y un movimiento con fecha futura se sale de cualquier filtro "hasta hoy" del
       * dashboard — se perdería justo el mes que el cliente está mirando.
       */
      const fecha = `${c.anio}-${String(c.mes).padStart(2, '0')}-01`;
      salida.push(colGrupo >= 0 ? [fecha, u.etiqueta, u.grupo ?? '', v] : [fecha, u.etiqueta, v]);
    }
  }
  if (salida.length < 2) return null;

  return {
    rows: salida,
    conceptos: utiles.length,
    periodos: columnasDeMes.length,
    motivo:
      `tiene ${utiles.length} conceptos con un valor por mes (${columnasDeMes.length} meses): ` +
      `se convirtió en ${salida.length - 1} movimientos, uno por concepto y mes`,
  };
}

/**
 * El año que usan los meses que no lo dicen.
 *
 * Un encabezado que dice solo "Enero" no alcanza, y equivocarse manda los gastos del cliente a
 * un año donde su dashboard no los va a buscar nunca. Se busca, en orden de confiabilidad:
 * el título de la hoja, el nombre de la hoja, y por último las FECHAS que ya se leyeron en el
 * resto del libro — que es el dato más fuerte cuando existe, porque son movimientos reales de
 * esa contabilidad.
 */
export function inferirAnio(params: {
  titulo?: string;
  nombreHoja?: string;
  fechasDelLibro?: unknown[];
}): number {
  for (const texto of [params.titulo, params.nombreHoja]) {
    if (!texto) continue;
    const m = /\b(20\d{2})\b/.exec(texto);
    if (m) return Number(m[1]);
  }
  const anios = new Map<number, number>();
  for (const f of params.fechasDelLibro ?? []) {
    const d = asDate(f);
    if (!d) continue;
    const a = Number(d.slice(0, 4));
    anios.set(a, (anios.get(a) ?? 0) + 1);
  }
  if (anios.size > 0) {
    return [...anios.entries()].sort((x, y) => y[1] - x[1])[0]![0];
  }
  return new Date().getUTCFullYear();
}

/** Reexport por comodidad del worker, que ya importa de este módulo. */
export { pareceNombreDePeriodo };
