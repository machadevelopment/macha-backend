import { asDate } from './row-assembly';

/**
 * Distingue una TABLA de movimientos de un REPORTE, sin llamar al modelo.
 *
 * ═══ QUÉ PROBLEMA RESUELVE ═══
 *
 * El pre-filtro de catálogos (`sheet-classifier.ts`) descarta hojas cuyos encabezados
 * describen entidades: clientes, proveedores, inventario. No cubre el otro caso, que es más
 * caro: hojas que no son tablas EN ABSOLUTO.
 *
 * `Info MACRO 2026`, de un archivo real de cliente (2026-08-14), tiene un bloque por mes
 * pegado a lo ancho, cada uno con sus propios títulos, y el resto celdas vacías:
 *
 *   [null,null,46023,null,...,"PRECIO INDIVIDUAL MENSUAL - ENERO",null,...,"COSTOS
 *    MENSUALES - ENERO",null,...,"VENTAS MENSUALES - ENERO",null,...]
 *
 * Le mandamos 436 filas al modelo. Es la hoja que hace que ese archivo cueste USD 2,61
 * contra USD 1,84 de uno equivalente sin ella, y lo que devuelve son filas marcadas.
 *
 * ═══ POR QUÉ NO ALCANZA CON "MUCHAS CELDAS VACÍAS" ═══
 *
 * Una tabla legítima también tiene huecos: columnas opcionales, meses sin movimiento. Lo que
 * distingue a un reporte no es que esté vacío, es que su ANCHO no significa nada — las
 * columnas no son campos repetidos fila a fila, son bloques de layout. Por eso se combinan
 * tres señales y se exige que coincidan.
 *
 * ═══ EL SESGO, OTRA VEZ, VA HACIA PAGAR DE MÁS ═══
 *
 * Ante la duda la hoja va al modelo. Descartar una hoja financiera pierde contabilidad del
 * cliente EN SILENCIO — no aparece en su dashboard y nadie lo nota. Descartar de menos solo
 * cuesta lo que ya cuesta hoy. Es la misma asimetría que gobierna `sheet-classifier.ts`.
 */

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * UNA SOLA TABLA DE MESES, Y TOLERA UN TYPO (2026-08-30)
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *
 * Antes había DOS vocabularios: esta alternación de regex y el `MESES_ES` de `sheet-unpivot`.
 * El propio archivo advertía que tenían que coincidir —"si una dice sí es período y la otra no
 * sabe cuál es, la hoja se marca como reporte y después no se puede despivotar"— y mantenerlas
 * a mano es exactamente el modo de fallo que la advertencia describe. Ahora la tabla vive acá
 * y `mesDeEncabezado` la consume, así que no pueden separarse.
 *
 * Y tolera UNA edición, porque un cliente escribe los meses A MANO: `Enrero`, `Febrro`,
 * `Abrl`, `Agosot`. Sin eso, la matriz de gastos con los meses mal escritos no se detecta como
 * reporte, no se despivota, se queda sin columna de fecha y **desaparece entera** — el cliente
 * ve utilidad neta igual a utilidad bruta, o sea que el producto le dice que operar su negocio
 * no cuesta nada. Medido: Q 48.240 en el libro de prueba.
 *
 * ═══ POR QUÉ ES SEGURO AFLOJAR ACÁ ═══
 *
 * Un mes suelto no decide nada: la señal de reporte exige **≥4 columnas de período** cubriendo
 * más del 25 % del encabezado, y el despivotado exige ≥3 sin repetir. Para que un typo haga
 * daño tendrían que confundirse tres o cuatro columnas a la vez, en la misma hoja.
 *
 * La tolerancia se mide contra la palabra del DICCIONARIO y solo desde 5 letras. Por eso
 * `mayo` (4) exige coincidencia exacta y una columna `Mayor` —libro mayor, que en una hoja
 * contable es un nombre normal— no se lee como mayo. Las abreviaturas de 3 letras tampoco se
 * aflojan: `mar` está a una edición de `mes`, `map`, `mor`.
 */
const MESES_POR_NOMBRE: Record<string, number> = {
  enero: 1, ene: 1, febrero: 2, feb: 2, marzo: 3, mar: 3, abril: 4, abr: 4,
  mayo: 5, may: 5, junio: 6, jun: 6, julio: 7, jul: 7, agosto: 8, ago: 8,
  septiembre: 9, setiembre: 9, sep: 9, sept: 9, set: 9,
  octubre: 10, oct: 10, noviembre: 11, nov: 11, diciembre: 12, dic: 12,
  january: 1, jan: 1, february: 2, march: 3, april: 4, apr: 4, june: 6, july: 7,
  august: 8, aug: 8, september: 9, october: 10, november: 11, december: 12, dec: 12,
}; // prettier-ignore

const LARGO_MINIMO_PARA_TOLERAR_TYPO = 5;

/** Distancia de edición 1: sustitución, inserción, borrado o transposición contigua. */
function aUnaEdicion(a: string, b: string): boolean {
  const d = a.length - b.length;
  if (d > 1 || d < -1) return false;
  if (a.length === b.length) {
    let i = 0;
    while (i < a.length && a[i] === b[i]) i++;
    if (i === a.length) return true;
    let j = a.length - 1;
    while (j > i && a[j] === b[j]) j--;
    if (i === j) return true;
    return j === i + 1 && a[i] === b[j] && a[j] === b[i];
  }
  const [largo, corto] = a.length > b.length ? [a, b] : [b, a];
  let i = 0;
  while (i < corto.length && largo[i] === corto[i]) i++;
  return largo.slice(i + 1) === corto.slice(i);
}

/**
 * Qué mes nombra esta palabra, tolerando un typo. `null` si no nombra ninguno.
 *
 * Es la ÚNICA fuente de nombres de mes del pipeline: la consume `pareceNombreDePeriodo` de
 * este módulo y `mesDeEncabezado` de `sheet-unpivot`.
 */
export function mesPorNombre(palabra: string, tolerarTypo = false): number | null {
  const p = palabra
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
  const exacto = MESES_POR_NOMBRE[p];
  if (exacto !== undefined) return exacto;
  if (!tolerarTypo) return null;
  for (const [nombre, mes] of Object.entries(MESES_POR_NOMBRE)) {
    if (nombre.length >= LARGO_MINIMO_PARA_TOLERAR_TYPO && aUnaEdicion(p, nombre)) return mes;
  }
  return null;
}

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * EL TYPO SE TOLERA POR CONTEXTO, NUNCA EN UNA ETIQUETA SUELTA
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *
 * La tolerancia por sí sola tiene falsos positivos que importan y el test los encontró antes
 * de que saliera: `Marca` está a UNA edición de `march` —y una concesionaria tiene esa columna
 * en su inventario—, igual que `Marco` de `marzo`, `Julia` de `julio` y `Género` de `enero`.
 * Un nombre de mes corto vive cerca de palabras que son nombres de columna perfectamente
 * normales, así que aflojar la comparación de una etiqueta AISLADA cambia un fallo por otro.
 *
 * Lo que resuelve la ambigüedad es el ENCABEZADO COMPLETO: en una hoja donde varias columnas
 * ya son meses bien escritos, una casi-coincidencia es un typo; en una hoja donde no hay
 * ninguno, es una palabra que se le parece. Por eso hacen falta **al menos un mes exacto y al
 * menos dos casi-coincidencias** para aceptar las segundas. `Marca` sola nunca es marzo, y
 * `Marca` al lado de un `Mayo` real tampoco (una sola casi-coincidencia no alcanza).
 *
 * Medido en la matriz de gastos con los meses escritos a mano —`Enrero · Febrro · Marzoo ·
 * Abrl · Mayo · Juno · Julioo · Agosot`—: un exacto y siete casi. Sin esto la hoja no se
 * despivotaba y sus Q 48.240 de gastos desaparecían del dashboard.
 */
export function mesesDeEncabezado(nombres: unknown[]): (number | null)[] {
  const texto = nombres.map((n) => (typeof n === 'string' ? n.trim().replace(/\s+/g, ' ') : ''));
  const exactos = texto.map((t) => mesDeEtiqueta(t, false));
  const casi = texto.map((t, i) => (exactos[i] === null ? mesDeEtiqueta(t, true) : null));
  const nExactos = exactos.filter((m) => m !== null).length;
  const nCasi = casi.filter((m) => m !== null).length;
  if (nExactos >= 1 && nCasi >= 2) return exactos.map((m, i) => m ?? casi[i]!);
  return exactos;
}

/** Un mes escrito como nombre, con año opcional. No cubre trimestres ni `2026-01`. */
function mesDeEtiqueta(t: string, tolerarTypo: boolean): number | null {
  const m = MES_CON_ANIO.exec(t.normalize('NFD').replace(/[\u0300-\u036f]/g, ''));
  return m === null ? null : mesPorNombre(m[1]!, tolerarTypo);
}
/*
 * Los TRIMESTRES son períodos igual que los meses (`Q1 2026`, `T1`, `1er trimestre`), y hay
 * negocios que presupuestan así. Sin reconocerlos, una matriz trimestral ni siquiera se
 * detecta como reporte: cae al camino normal, se queda sin columna de fecha y se descarta
 * entera. Medido: Q 77.280 de gastos perdidos en el libro de prueba.
 *
 * ⚠️ Esta lista tiene que coincidir con `mesDeEncabezado` de `sheet-unpivot.ts`, que es quien
 * traduce la etiqueta a un mes concreto. Si una dice "sí es período" y la otra no sabe cuál
 * es, la hoja se marca como reporte y después no se puede despivotar: se descarta igual, que
 * es el peor de los dos mundos. Hay test que fija la equivalencia.
 */
const TRIMESTRE = String.raw`(?:q|t|trim(?:estre)?)[\s.-]*[1-4](?:[\s./-]*\d{2,4})?|[1-4](?:er|do|ro|to)?[\s.-]*(?:t|trim(?:estre)?)(?:[\s./-]*\d{2,4})?`;
const SEMESTRE = String.raw`(?:s|sem(?:estre)?)[\s.-]*[12](?:[\s./-]*\d{2,4})?|[12](?:er|do)?[\s.-]*(?:s|sem(?:estre)?)(?:[\s./-]*\d{2,4})?`;

/** Todo lo que es período SIN ser un nombre de mes; los nombres los resuelve `mesPorNombre`. */
const PERIODO = new RegExp(
  `^(?:\\d{4}[-/]\\d{1,2}|\\d{1,2}[-/]\\d{4}|${TRIMESTRE}|${SEMESTRE})$`,
  'i',
);

/** `enero` · `ene-26` · `Enrero 2026` · `ene.2026`: nombre de mes con año opcional. */
const MES_CON_ANIO = /^([a-z]{3,12})\.?[\s./-]*(\d{0,4})$/i;

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * UN MARCADOR DE PERÍODO TAMBIÉN PUEDE SER UNA FECHA, NO SOLO UN NOMBRE (2026-08-30)
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *
 * `pareceNombreDePeriodo` reconoce "Enero", "ene-26", "2026-01". No reconoce lo que un Excel
 * de verdad pone en esa columna cuando la escribe una fórmula: **una fecha**, casi siempre el
 * día 1 del mes. Verificado en los dos archivos que motivaron esto — el `Resumen_Mensual` de
 * KapePrueba trae los seriales 46023, 46054, 46082… que son 2026-01-01, 02-01, 03-01.
 *
 * El agujero es exactamente el de la señal 6, con el período escrito de otra forma: una hoja
 * de una fila por mes se lee como tabla de movimientos y **sus cifras se suman ENCIMA de la
 * hoja de detalle que las originó**. Medido contra el archivo hostil: Q 364.788 de ingresos
 * contados dos veces, el 100 % de la facturación duplicada.
 *
 * ═══ POR QUÉ EL DÍA DEL MES ES LA GUARDA, Y NO UN DETALLE ═══
 *
 * "Una fila por mes" a secas es demasiado laxo: una PYME chica puede tener ocho movimientos
 * reales, uno en cada mes, y descartarlos sería perder su contabilidad — el error que esta
 * casa se niega a cometer en silencio.
 *
 * Lo que separa un MARCADOR de período de una fecha de movimiento es que el marcador no elige
 * el día: lo pone la fórmula, y sale siempre el mismo (el 1, o el último del mes). Un
 * movimiento ocurre el día que ocurre, así que sus días varían. Por eso se exige coherencia
 * de día además de unicidad de mes: con las dos, un listado real no puede caer acá.
 */
function periodoDeFecha(v: unknown): { mes: string; dia: number; finDeMes: boolean } | null {
  const f = asDate(v);
  if (f === null) return null;
  const [a, m, d] = f.split('-').map(Number) as [number, number, number];
  const ultimo = new Date(Date.UTC(a, m, 0)).getUTCDate();
  return { mes: `${a}-${String(m).padStart(2, '0')}`, dia: d, finDeMes: d === ultimo };
}

/**
 * ¿Este nombre de columna es un PERÍODO? ("ene-25", "feb-26", "2026-06", "Enero", "Jan 2025")
 *
 * Es la firma de una hoja donde los datos están A LO ANCHO: cada columna es un mes y cada
 * fila una entidad —un cliente, un producto— con doce o veinticuatro valores al lado. Una
 * fila ahí no es un movimiento: son muchos.
 */
export function pareceNombreDePeriodo(nombre: unknown): boolean {
  if (typeof nombre !== 'string') return false;
  const t = nombre.trim().replace(/\s+/g, ' ');
  if (PERIODO.test(t)) return true;
  return mesDeEtiqueta(t, false) !== null;
}

const vacia = (c: unknown): boolean => c === null || c === undefined || String(c).trim() === '';

/** Largo mínimo para que un texto CUENTE algo. `GTQ` no; `Servicio de vigilancia` sí. */
const LARGO_MINIMO_DESCRIPTIVO = 5;

/**
 * Si alguna columna que NO es la primera trae texto que describe el hecho.
 *
 * La primera se excluye porque es justamente la que se está juzgando como marcador de período.
 * De las demás basta una: un libro de movimientos siempre dice qué pasó; un resumen solo dice
 * cuánto.
 */
function tieneColumnaDescriptiva(datos: unknown[][]): boolean {
  const muestra = datos.slice(0, 60);
  const ancho = Math.max(...muestra.map((f) => f.length), 0);
  for (let c = 1; c < ancho; c++) {
    const valores = muestra.map((f) => f[c]).filter((v) => !vacia(v));
    if (valores.length === 0) continue;
    const descriptivos = valores.filter(
      (v) =>
        typeof v === 'string' &&
        v.trim().length >= LARGO_MINIMO_DESCRIPTIVO &&
        asDate(v) === null &&
        !/^[\s$Q€]*-?[\d.,\s]+[\s$Q€]*$/.test(v),
    ).length;
    if (descriptivos / valores.length > 0.7) return true;
  }
  return false;
}

export interface FormaDeHoja {
  /** `true` = parece un reporte/tabla dinámica, no un listado de movimientos. */
  esReporte: boolean;
  /** En lenguaje del cliente, para `documents.error_reason`. Vacío si es tabular. */
  motivo: string;
}

/**
 * Juzga la forma de una hoja por su geometría, con los encabezados YA localizados
 * (`sheet-header.ts`) — sobre la fila 0 cruda daría cualquier cosa en un archivo con títulos.
 */
/**
 * Cuántos períodos distintos hacen falta para declarar "resumen" MIRANDO LA HOJA SOLA.
 *
 * Seis, y el número está razonado abajo en la señal 6-bis: por debajo, una hoja de cinco filas
 * con fechas del día 1 puede ser contabilidad real de una PYME chica, y descartarla la pierde
 * en silencio. Ese es el peor fallo de esta casa y por eso el umbral no baja acá.
 *
 * ⚠️ Pero SÍ baja cuando hay una segunda señal independiente. Ver `pareceResumenPorPeriodo`.
 */
const MIN_PERIODOS_PARA_RESUMEN = 6;

/**
 * ¿Esta hoja tiene FORMA de resumen por período? (una fila por mes, el día lo pone la fórmula)
 *
 * Es la señal 6-bis extraída para que pueda usarse con otro mínimo, y vive UNA sola vez a
 * propósito: si el dedup y la forma de hoja juzgaran distinto qué es un resumen, el mismo
 * archivo daría cifras distintas según cuál filtro lo viera primero. Es la lección que este
 * repo ya escribió para `cumpleFirma` y para `mesPorNombre`.
 *
 * ⚠️ **Con `minimo` por debajo de `MIN_PERIODOS_PARA_RESUMEN` esta función NO alcanza sola.**
 * Cuatro fechas del día 1 son sugerentes y no concluyentes: hay contabilidad real así. Solo se
 * puede bajar el mínimo cuando quien pregunta trae otra evidencia independiente — hoy el único
 * llamador es `sheet-duplication`, y solo después de comprobar que la hoja empata AL CENTAVO
 * con otra del mismo libro. Ver la nota del piso allá.
 */
export function pareceResumenPorPeriodo(
  rows: unknown[][],
  minimo = MIN_PERIODOS_PARA_RESUMEN,
): boolean {
  const datos = rows.slice(1);
  if (datos.length === 0) return false;

  const marcadores = datos
    .map((f) => periodoDeFecha(f[0]))
    .filter((p): p is NonNullable<typeof p> => p !== null);
  if (marcadores.length < minimo || marcadores.length / datos.length <= 0.8) return false;

  const meses = new Set(marcadores.map((p) => p.mes)).size;
  const dias = new Set(marcadores.map((p) => p.dia));
  // El día lo pone la fórmula, no el hecho: sale siempre el 1, o el último del mes.
  const diaCoherente = dias.size === 1 || marcadores.every((p) => p.finDeMes);

  // Un resumen tiene el período y CIFRAS, nada más. Ver el veto de la señal 6-bis.
  return meses / marcadores.length > 0.9 && diaCoherente && !tieneColumnaDescriptiva(datos);
}

export function analizarFormaDeHoja(rows: unknown[][]): FormaDeHoja {
  const ok: FormaDeHoja = { esReporte: false, motivo: '' };

  const encabezado = rows[0] ?? [];
  const datos = rows.slice(1);
  const nombradosTodos = encabezado.filter((c) => !vacia(c));

  /*
   * ═══════════════════════════════════════════════════════════════════════════════════════════
   * LAS DOS SEÑALES DE PERÍODO SE JUZGAN ANTES DEL MÍNIMO DE FILAS
   * ═══════════════════════════════════════════════════════════════════════════════════════════
   *
   * El corte de abajo ("con pocas filas no hay geometría que juzgar, y una hoja chica tampoco
   * cuesta") vale para las señales GEOMÉTRICAS, que necesitan masa para significar algo. No
   * vale para estas dos: un encabezado con doce meses es un reporte tenga tres filas o
   * trescientas, y la premisa de que una hoja chica "no cuesta" resultó falsa.
   *
   * Medido sobre un corpus de diez libros reales (2026-08-25). Las dos hojas que se colaban
   * tenían DIEZ filas cada una:
   *
   *   · `ReporteMensualGastos` — `Categoria · Enero · Febrero · … · Diciembre`. Doce columnas
   *     que son meses, y se leía como tabla de movimientos.
   *   · `ResumenGerencial` — `Mes · Ingresos Totales · Gastos Totales · Utilidad Estimada`,
   *     una fila por mes. Sus Q 324.562 se sumaban ENCIMA de los Q 304.310 de la hoja de
   *     ingresos real: el hotel veía su facturación duplicada.
   *
   * Lo que cuesta una hoja chica no son tokens: es contar el mismo dinero dos veces.
   */
  /*
   * La tolerancia a typos se decide sobre el ENCABEZADO ENTERO (ver `mesesDeEncabezado`), no
   * etiqueta por etiqueta: una casi-coincidencia suelta es una palabra parecida, y varias
   * junto a un mes bien escrito son una matriz con los meses escritos a mano.
   */
  const mesesTolerantes = mesesDeEncabezado(nombradosTodos);
  const periodosEnColumnas = nombradosTodos.filter(
    (c, i) => mesesTolerantes[i] !== null || pareceNombreDePeriodo(c),
  ).length;
  if (periodosEnColumnas >= 4 && periodosEnColumnas / Math.max(nombradosTodos.length, 1) > 0.25) {
    return {
      esReporte: true,
      motivo:
        `tiene ${periodosEnColumnas} columnas que son meses o períodos: los datos están a lo ancho ` +
        '(una fila por cliente o producto, con un valor por mes) en vez de un movimiento por fila',
    };
  }

  /*
   * 6. UN PERÍODO POR FILA, SIN REPETIRSE: el reporte TRANSPUESTO.
   *
   * ═══ EL CASO QUE SE ESCAPÓ (`U3TECH_Demo_Datos_Ampliado`, 2026-08-19) ═══
   *
   * Las cinco señales de arriba buscan reportes ANCHOS: los meses puestos a lo largo, una
   * fila por cliente. Este archivo trae el mismo agregado girado 90 grados —`Resumen_Mensual`
   * y `Flujo_Caja`— con los meses hacia ABAJO, una fila por mes y once columnas limpias sin
   * un solo hueco.
   *
   * No dispara ni una: la cobertura del encabezado es 1, no hay celdas vacías, tiene 11
   * columnas y ningún nombre repetido. Se ve idéntica a una tabla de movimientos.
   *
   * Y el daño es el mismo que el de `sheet-duplication.ts`: es LA MISMA PLATA otra vez. El
   * archivo declara USD 4.840.744 de facturación en `Facturacion_Clientes` (1.403 filas de
   * detalle) y los repite en `Resumen_Mensual` (36 meses) y en `Flujo_Caja` (lo cobrado).
   * Sin este filtro, el dashboard del cliente puede llegar a mostrar el triple de sus
   * ingresos reales.
   *
   * ═══ POR QUÉ `sheet-duplication.ts` NO LO ATRAPA ═══
   *
   * Ese detector compara TOTALES entre hojas, y acá no coinciden: `Resumen_Mensual` incluye
   * una fila final "Total" que vuelve a sumar la columna entera, así que da 9.681.488 contra
   * los 4.840.744 del detalle. La fila que causa el daño es justamente la que lo esconde.
   *
   * ═══ LA SEÑAL: PERÍODOS ÚNICOS, NO SOLO PERÍODOS ═══
   *
   * Que la primera columna sean meses NO basta — una tabla de movimientos con una columna
   * "Mes" es perfectamente legítima y común. Lo que distingue a un agregado es que cada
   * período aparece UNA SOLA VEZ: es una fila POR mes. En un listado de movimientos los
   * meses se repiten decenas de veces, porque hay muchos movimientos en cada uno.
   *
   * Por eso se exige unicidad casi total además de la proporción. Con las dos condiciones,
   * una hoja de 900 gastos con columna de mes no se toca, y una de 36 filas que son 36 meses
   * distintos sí.
   */
  const primeraColumna = datos.map((f) => f[0]);
  const conPeriodo = primeraColumna.filter(pareceNombreDePeriodo);
  if (conPeriodo.length >= 6 && conPeriodo.length / datos.length > 0.8) {
    const unicos = new Set(conPeriodo.map((c) => String(c).trim().toLowerCase())).size;
    if (unicos / conPeriodo.length > 0.9) {
      return {
        esReporte: true,
        motivo:
          `es un resumen por período: sus ${unicos} filas son ${unicos} meses distintos, uno por ` +
          'fila, no movimientos. Sus cifras ya están en la hoja de detalle que las origina',
      };
    }
  }

  /*
   * 6-bis. EL MISMO RESUMEN, CON EL PERÍODO ESCRITO COMO FECHA. Ver `periodoDeFecha`.
   *
   * Misma masa mínima y misma exigencia de unicidad que la señal de arriba, más la coherencia
   * de día que impide confundirlo con ocho movimientos reales repartidos en ocho meses.
   */
  const marcadores = primeraColumna
    .map(periodoDeFecha)
    .filter((p): p is NonNullable<typeof p> => p !== null);
  if (marcadores.length >= MIN_PERIODOS_PARA_RESUMEN && marcadores.length / datos.length > 0.8) {
    const meses = new Set(marcadores.map((p) => p.mes)).size;
    const dias = new Set(marcadores.map((p) => p.dia));
    const diaCoherente = dias.size === 1 || marcadores.every((p) => p.finDeMes);
    /*
     * ═══════════════════════════════════════════════════════════════════════════════════════
     * UN PAGO RECURRENTE TAMBIÉN CAE SIEMPRE EL MISMO DÍA (2026-08-30)
     * ═══════════════════════════════════════════════════════════════════════════════════════
     *
     * La coherencia de día se justificó arriba con "un movimiento ocurre el día que ocurre,
     * así que sus días varían". Es cierto de una venta y **falso del gasto fijo de cualquier
     * PYME**: el alquiler se paga el 1, la planilla el 30, la cuota del préstamo el 15. O sea
     * que la guarda escrita para no confundir un resumen con movimientos reales golpeaba
     * justo a los movimientos más previsibles que existen — y con más fuerza en el día 1 y en
     * el último del mes, que son precisamente los dos que `finDeMes` y `dias.size === 1`
     * declaran marcador.
     *
     * Medido: dos hojas de gastos recurrentes se descartaban enteras —ocho pagos de
     * mantenimiento el día 20 y doce de vigilancia el día 15—. No es un dato que falta: deja
     * el resultado del período INFLADO, que es el fallo que esta casa ya pagó con la matriz de
     * gastos de KapePrueba.
     *
     * ═══ LA SEÑAL ES QUE UN RESUMEN NO TIENE NADA QUE CONTAR, SOLO CUÁNTO ═══
     *
     * El primer intento fue vetar por CONTRAPARTE (`pareceLibroDeMovimientos`): no se le paga
     * a "enero". Correcto y demasiado angosto — ese mismo archivo lo advierte en su comentario:
     * *"la hoja de gastos de una PYME no nombra proveedor y lo es"*. La hoja
     * `Fecha · Descripcion · Categoria · Monto` seguía muriendo.
     *
     * Lo que sí generaliza: un resumen por período tiene el período y CIFRAS, nada más. Las dos
     * hojas reales que motivaron esta señal lo confirman — `Mes · Venta Neta · Unidades` y
     * `Mes · Ingresos Totales · Gastos Totales · Utilidad Estimada`: ni una columna de texto.
     * Un libro de movimientos siempre trae al menos una que dice QUÉ pasó: el concepto, el
     * rubro, la contraparte, la descripción.
     *
     * El piso de 5 caracteres deja fuera la columna de MONEDA (`GTQ`, `USD`, `Q`), que es texto
     * y aparece en hojas de las dos clases; sin el piso el veto se cumpliría siempre y la señal
     * quedaría apagada.
     */
    if (meses / marcadores.length > 0.9 && diaCoherente && !tieneColumnaDescriptiva(datos)) {
      return {
        esReporte: true,
        motivo:
          `es un resumen por período: sus ${meses} filas son ${meses} meses distintos, uno por ` +
          'fila, no movimientos. Sus cifras ya están en la hoja de detalle que las origina',
      };
    }
  }

  /*
   * El corte de abajo vale para las señales GEOMÉTRICAS, que necesitan masa para significar
   * algo. Las dos de PERÍODO no la necesitan y por eso van antes: seis meses distintos en seis
   * filas es tan concluyente como sesenta en sesenta.
   *
   * Medido en la auditoría contra el validador de extracción (2026-08-25). El
   * `ResumenGerencial` de un hotel —`Mes · Ingresos Totales · Gastos Totales · Utilidad
   * Estimada`, seis filas— cumplía TODOS los umbrales de la señal de arriba y se colaba solo
   * por tener siete filas en total. Sus USD 324.562 se sumaban ENCIMA de los USD 304.310 de la
   * hoja de ingresos real: el hotel veía su facturación duplicada.
   *
   * La premisa de que "una hoja chica no cuesta" es falsa cuando la hoja es un AGREGADO: lo que
   * cuesta no son tokens, es contar el mismo dinero dos veces. Y el umbral de seis meses
   * distintos sigue protegiendo el otro lado — una hoja de cinco filas no se toca.
   */
  // Con pocas filas no hay geometría que juzgar, y una hoja chica tampoco cuesta.
  if (rows.length < 8) return ok;

  const nombrados = encabezado.filter((c) => !vacia(c));
  const anchoEncabezado = nombrados.length;
  const anchoDeclarado = Math.max(encabezado.length, ...datos.map((f) => f.length));

  /*
   * 1. ENCABEZADO CON HUECOS. En una tabla, cada columna tiene nombre. Un reporte tiene
   *    títulos sueltos separados por decenas de celdas vacías, porque esos "títulos" rotulan
   *    bloques, no columnas.
   */
  const cobertura = anchoDeclarado > 0 ? anchoEncabezado / anchoDeclarado : 1;

  /*
   * 2. CELDAS VACÍAS EN LOS DATOS. Alta por sí sola no prueba nada —una tabla con columnas
   *    opcionales también las tiene— pero junto a un encabezado con huecos sí: significa que
   *    el ancho es layout, no campos.
   */
  const celdas = datos.reduce((n, f) => n + Math.max(f.length, 1), 0);
  const huecos = datos.reduce((n, f) => n + f.filter(vacia).length, 0);
  const proporcionVacias = celdas > 0 ? huecos / celdas : 0;

  /*
   * 3. ANCHO DESPROPORCIONADO. Una tabla de movimientos de PYME rara vez pasa de ~30 campos.
   *    Cuarenta y pico de columnas casi siempre son meses o categorías puestas a lo ancho —
   *    que es justamente el layout que una fila no puede representar.
   */
  const demasiadoAncha = anchoDeclarado > 40;

  if (cobertura < 0.5 && proporcionVacias > 0.5) {
    return {
      esReporte: true,
      motivo:
        'parece un reporte con bloques y títulos sueltos, no un listado de movimientos fila por fila',
    };
  }

  /*
   * 5. NOMBRES DE COLUMNA REPETIDOS. Una tabla de verdad no repite nombres: cada columna es
   *    un campo distinto. Un layout por BLOQUES sí los repite, uno por bloque.
   *
   *    Caso real ("Resumen" de un archivo de cliente): "Costo", "Venta", "Entregado",
   *    "Ingreso por ventas" aparecen una vez por producto —KAPEL BLEND, HOUSE BLEND,
   *    OFFICE BLEND…— a lo ancho. Una fila es un mes con setenta valores repartidos en
   *    bloques, no un movimiento.
   *
   *    Lo destapó el corpus: al arreglar la detección de encabezado, esta hoja pasó de
   *    "reporte" a "tabla" porque su encabezado real SÍ cubre el ancho. La cobertura dejó de
   *    delatarla y hacía falta otra señal.
   */
  const nombres = nombrados.map((c) => String(c).trim().toLowerCase());
  const repetidos = nombres.length - new Set(nombres).size;
  if (nombres.length >= 10 && repetidos / nombres.length > 0.25) {
    return {
      esReporte: true,
      motivo:
        `repite ${repetidos} nombres de columna: está armada por bloques (uno por producto o ` +
        'categoría) en vez de una columna por campo',
    };
  }

  if (demasiadoAncha && cobertura < 0.7) {
    return {
      esReporte: true,
      motivo:
        'tiene demasiadas columnas con nombre incompleto: parece una tabla dinámica por meses o categorías',
    };
  }

  return ok;
}
