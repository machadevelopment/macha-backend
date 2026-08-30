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

const MESES =
  'ene|feb|mar|abr|may|jun|jul|ago|sep|sept|oct|nov|dic|jan|apr|aug|dec|enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre';
const PERIODO = new RegExp(
  `^(?:(?:${MESES})[\\s./-]*\\d{0,4}|\\d{4}[-/]\\d{1,2}|\\d{1,2}[-/]\\d{4})$`,
  'i',
);

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
  return PERIODO.test(nombre.trim().replace(/\s+/g, ' '));
}

const vacia = (c: unknown): boolean => c === null || c === undefined || String(c).trim() === '';

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
  const periodosEnColumnas = nombradosTodos.filter(pareceNombreDePeriodo).length;
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
  const fechasDePeriodo = primeraColumna.map(periodoDeFecha);
  const marcadores = fechasDePeriodo.filter((p): p is NonNullable<typeof p> => p !== null);
  if (marcadores.length >= 6 && marcadores.length / datos.length > 0.8) {
    const meses = new Set(marcadores.map((p) => p.mes)).size;
    const dias = new Set(marcadores.map((p) => p.dia));
    const diaCoherente = dias.size === 1 || marcadores.every((p) => p.finDeMes);
    if (meses / marcadores.length > 0.9 && diaCoherente) {
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
