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
 * ¿Este nombre de columna es un PERÍODO? ("ene-25", "feb-26", "2026-06", "Enero", "Jan 2025")
 *
 * Es la firma de una hoja donde los datos están A LO ANCHO: cada columna es un mes y cada
 * fila una entidad —un cliente, un producto— con doce o veinticuatro valores al lado. Una
 * fila ahí no es un movimiento: son muchos.
 */
const MESES =
  'ene|feb|mar|abr|may|jun|jul|ago|sep|sept|oct|nov|dic|jan|apr|aug|dec|enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre';
const PERIODO = new RegExp(
  `^(?:(?:${MESES})[\\s./-]*\\d{0,4}|\\d{4}[-/]\\d{1,2}|\\d{1,2}[-/]\\d{4})$`,
  'i',
);

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
  // Con pocas filas no hay geometría que juzgar, y una hoja chica tampoco cuesta.
  if (rows.length < 8) return ok;

  const encabezado = rows[0] ?? [];
  const datos = rows.slice(1);

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
   * 4. COLUMNAS QUE SON PERÍODOS. La firma inconfundible de los datos a lo ancho:
   *    `["Cliente","ene-25","feb-25",...,"dic-26","Tipo de cliente"]`. Cada fila es un
   *    cliente con veinticuatro meses al lado — no es un movimiento, son veinticuatro.
   *
   *    Se exige un MÍNIMO ABSOLUTO además de la proporción: una tabla de movimientos puede
   *    tener una columna "Mes" o "Periodo" perfectamente legítima, y con solo la proporción
   *    una hoja angosta con dos columnas así se descartaría sin motivo.
   */
  const periodos = nombrados.filter(pareceNombreDePeriodo).length;
  if (periodos >= 4 && periodos / Math.max(nombrados.length, 1) > 0.25) {
    return {
      esReporte: true,
      motivo:
        `tiene ${periodos} columnas que son meses o períodos: los datos están a lo ancho ` +
        '(una fila por cliente o producto, con un valor por mes) en vez de un movimiento por fila',
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
