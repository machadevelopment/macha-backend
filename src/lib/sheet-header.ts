/**
 * Encuentra la fila de ENCABEZADOS de una hoja, en vez de asumir que es la primera.
 *
 * ═══ POR QUÉ ═══
 *
 * Todo lo demás de la ingesta cuelga de este supuesto: el pre-filtro de catálogos mira la
 * fila 0, el mapa de columnas se indexa contra la fila 0, y los índices que devuelve el
 * modelo apuntan a la fila 0. Si el encabezado real está más abajo, TODO se desplaza a la vez
 * y no falla nada visible — simplemente los datos salen de las columnas equivocadas.
 *
 * Y no es un caso raro: es el formato normal de un Excel hecho por una persona. Un archivo
 * real de cliente (2026-08-14):
 *
 *   [0] ["KAPEL ROASTING"]
 *   [1] ["REPORTE DE VENTAS "]
 *   [2] [46023, null, ..., "UNIDADES", null, "EFECTIVO"]
 *   [3] ["Fecha","Cliente","Calidad","Presentación","Cantidad","Peso de bolsa","P. Unidad",
 *        "Sub total","Costo unitario del pedido","Costo del pedido", ...]   ← el de verdad
 *
 * Leíamos `["KAPEL ROASTING"]` como los nombres de columna. Y esa hoja trae
 * "Costo del pedido": el costo por fila estaba ahí y no lo veíamos por dos líneas de título.
 *
 * ═══ EL SESGO VA HACIA NO MOVERSE ═══
 *
 * Ante la duda se devuelve 0. Equivocarse eligiendo una fila de datos como encabezado es peor
 * que quedarse en la primera: descarta una fila real del cliente Y desplaza el mapa. Por eso
 * hace falta que un candidato gane con claridad, no por poco.
 */

/** Solo se busca cerca del principio: un encabezado a la fila 30 es otra clase de archivo. */
const MAX_FILAS_A_MIRAR = 12;

const vacia = (c: unknown): boolean => c === null || c === undefined || String(c).trim() === '';

/** Una celda de encabezado es texto: un nombre de columna no es un número ni una fecha. */
const esTexto = (c: unknown): boolean =>
  typeof c === 'string' && c.trim() !== '' && !/^-?[\d.,]+$/.test(c.trim());

/**
 * Qué tan "encabezado" se ve una fila, de 0 a 1.
 *
 * Tres señales, y ninguna basta sola:
 *   · casi todas sus celdas son TEXTO — una fila de datos trae números y fechas;
 *   · sus valores son ÚNICOS — "Fecha, Cliente, Monto" no repite, una fila de datos sí puede;
 *   · es ANCHA — un título ocupa una celda, un encabezado ocupa toda la tabla.
 */
function puntaje(fila: unknown[], anchoMaximo: number): number {
  const llenas = fila.filter((c) => !vacia(c));
  if (llenas.length < 2) return 0; // un título de una celda no es un encabezado

  const proporcionTexto = llenas.filter(esTexto).length / llenas.length;
  const unicos = new Set(llenas.map((c) => String(c).trim().toLowerCase())).size / llenas.length;
  const cobertura = Math.min(1, llenas.length / Math.max(anchoMaximo, 1));

  /*
   * ═══ UN ENCABEZADO NOMBRA LAS COLUMNAS: SI NOMBRA POCAS, ES UN TÍTULO ═══
   *
   * Piso duro y no solo un peso, porque sin él la aritmética se da vuelta. Caso real
   * (2026-08-14, hoja "Resumen" de un archivo de cliente):
   *
   *   [0] 6 celdas de 76:  "RESUMEN ANNUAL 2026", "KAPEL BLEND", "HOUSE BLEND", ...
   *   [1] 69 celdas de 76: "Mes", "Clientes", "Cantidad", "Peso en gr", ...   ← el real
   *
   * La fila 0 gana en proporción de texto (1,0) y en unicidad (1,0) porque son seis rótulos
   * distintos. La fila 1 queda PENALIZADA en unicidad por repetir etiquetas de bloque
   * ("Entregado", "Ingreso por ventas") una vez por producto. Resultado: el título le ganaba
   * al encabezado.
   *
   * Y esto se me pasó en el test: había escrito una versión simplificada de esa hoja que sí
   * daba 1. Con la hoja de verdad daba 0. El corpus de hojas reales es lo que lo destapó.
   */
  if (cobertura < 0.25) return 0;

  // La cobertura pesa más que las otras dos justamente por lo de arriba: es la señal que
  // distingue "nombra la tabla" de "rotula algo", y las otras dos se dejan engañar.
  return proporcionTexto * 0.35 + unicos * 0.15 + cobertura * 0.5;
}

/**
 * Índice de la fila de encabezados. `0` si no hay evidencia clara de otra cosa.
 *
 * El desempate no es solo "el mejor puntaje": el candidato tiene que verse claramente MÁS
 * encabezado que la fila 0 y, sobre todo, las filas que le siguen tienen que verse menos
 * encabezado que él. Esa segunda condición es la que evita el error caro — en una hoja donde
 * TODAS las filas son texto (un catálogo de nombres, por ejemplo) ninguna fila destaca sobre
 * las de abajo, así que se queda en 0 y no se descarta un dato real.
 */
export function detectarFilaDeEncabezado(rows: unknown[][]): number {
  if (rows.length < 2) return 0;

  const anchoMaximo = Math.max(...rows.map((f) => f.length));
  const limite = Math.min(MAX_FILAS_A_MIRAR, rows.length - 1);

  const base = puntaje(rows[0] ?? [], anchoMaximo);
  let mejor = 0;
  let mejorPuntaje = base;

  for (let i = 1; i < limite; i++) {
    const p = puntaje(rows[i]!, anchoMaximo);

    /*
     * Las filas SIGUIENTES tienen que parecer datos, no más encabezados. Es lo que distingue
     * "acá empieza la tabla" de "esta hoja es toda texto". Se miran tres y basta con el
     * promedio: una sola fila siguiente puede ser un subtotal o una fila rara.
     */
    const siguientes = rows.slice(i + 1, i + 4);
    if (siguientes.length === 0) continue;
    const promedioSiguientes =
      siguientes.reduce((n, f) => n + puntaje(f, anchoMaximo), 0) / siguientes.length;

    // Tiene que ganarle a lo que ya teníamos Y destacar sobre lo que viene abajo. Los dos
    // márgenes son deliberados: sin ellos, cualquier fila un poco mejor movería el corte.
    if (p > mejorPuntaje + 0.15 && p > promedioSiguientes + 0.2) {
      mejor = i;
      mejorPuntaje = p;
    }
  }

  return mejor;
}
