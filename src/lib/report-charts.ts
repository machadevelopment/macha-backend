/**
 * Gráficas del reporte — CU-868kt4ap8.
 *
 * ═══ POR QUÉ SVG ESCRITO A MANO ═══
 *
 * El reporte se renderiza en el SERVIDOR y viaja como HTML autenticado y como PDF. No hay
 * DOM, así que Recharts —la librería del frontend— no es una opción: necesita React y un
 * navegador. Y meter una dependencia de gráficas de servidor para dos figuras sería pagar
 * un árbol entero por dos polígonos, con la verificación de compatibilidad con Bun que
 * exige el CLAUDE.md por delante.
 *
 * SVG plano lo dibuja cualquier navegador sin script, sobrevive a un `print` a PDF y no
 * agrega superficie de ataque: acá no se interpola nada que venga del usuario salvo por
 * `escaparXml`, y las etiquetas de categoría SÍ vienen de su Excel.
 *
 * ═══ LOS COLORES NO SON DECORACIÓN (regla de los DOS VERDES) ═══
 *
 * El salvia de marca dice "esto es Macha" y **nunca va sobre un dato**. Por eso:
 *
 *   · La tendencia usa los colores FUNCIONALES —verde para el dinero que entra, rojo para
 *     el que sale—, que es exactamente lo que la regla reserva para las series.
 *   · Las barras de costo van en TINTA NEUTRA. Un desglose de costos es una composición,
 *     no un veredicto: pintar de rojo la categoría más grande diría "esto está mal" sobre
 *     un gasto que puede ser el normal del negocio.
 *
 * ═══ SIN EJE Y ROTULADO, A PROPÓSITO ═══
 *
 * La cifra exacta ya está en la tabla que acompaña a cada gráfica. Repetirla en un eje
 * apretado dentro de un PDF de una columna competiría con ella y obligaría a decidir cuánto
 * redondear. La gráfica responde a la FORMA —si sube, si cae, cuánto pesa cada categoría—
 * que es lo único que hace mejor que un número.
 */

/** Un punto de la serie, tal como lo arma `report-sections`. */
export interface PuntoDeTendencia {
  date: string;
  revenue: number;
  cogs: number;
  opex: number;
}

/** Verde y rojo FUNCIONALES (design guide). Nunca el salvia de marca sobre un dato. */
const VERDE = '#16A34A';
const ROJO = '#DC2626';
const TINTA = '#1C1C1C';
const GRIS = '#6B6B6B';
const LINEA = '#E5E5E5';

/** El `viewBox` fija la geometría; el ancho real lo pone el CSS del contenedor. */
const ANCHO = 640;
const ALTO = 180;
const MARGEN = 8;

function escaparXml(texto: string): string {
  return texto
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Redondeo a 2 decimales: un SVG con 14 decimales por punto pesa el triple sin verse mejor. */
const r2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * Convierte una serie de valores en la lista de puntos `x,y` del polígono.
 *
 * `maximo` se recibe de fuera y no se calcula por serie: las dos líneas —entradas y
 * salidas— tienen que compartir escala, porque el sentido de la gráfica es COMPARARLAS. Con
 * escalas independientes, un mes de gastos pequeños se dibujaría igual de alto que uno de
 * ingresos grandes y la figura mentiría.
 */
function puntos(valores: number[], maximo: number): string {
  if (valores.length === 0) return '';
  const util = ALTO - MARGEN * 2;
  // Una serie de UN punto no tiene ancho que repartir: se ancla a la izquierda en vez de
  // dividir entre cero.
  const paso = valores.length === 1 ? 0 : (ANCHO - MARGEN * 2) / (valores.length - 1);
  return valores
    .map((v, i) => {
      const x = MARGEN + paso * i;
      // `maximo <= 0` significa que todo es cero: la línea va al piso, no a la mitad.
      const y = maximo <= 0 ? ALTO - MARGEN : ALTO - MARGEN - (v / maximo) * util;
      return `${r2(x)},${r2(y)}`;
    })
    .join(' ');
}

/**
 * Tendencia del período: lo que entra contra lo que sale.
 *
 * Devuelve cadena vacía cuando no hay con qué dibujar —serie vacía o un solo punto— y el
 * llamador omite la sección. Una gráfica de un punto es una mancha: no muestra tendencia
 * alguna y ocupa el mismo espacio que una que sí.
 */
export function svgTendencia(
  serie: PuntoDeTendencia[],
  etiquetas: { entradas: string; salidas: string },
): string {
  if (serie.length < 2) return '';

  const entradas = serie.map((p) => p.revenue);
  // Costo directo + gasto operativo: es como sale el dinero de la cuenta. Separarlos
  // contestaría otra pregunta, y esa la contesta el desglose por categoría de abajo.
  const salidas = serie.map((p) => p.cogs + p.opex);
  const maximo = Math.max(...entradas, ...salidas);

  const base = ALTO - MARGEN;
  const areaEntradas = `${MARGEN},${base} ${puntos(entradas, maximo)} ${r2(ANCHO - MARGEN)},${base}`;

  return [
    `<svg viewBox="0 0 ${ANCHO} ${ALTO}" role="img" aria-label="${escaparXml(etiquetas.entradas)} / ${escaparXml(etiquetas.salidas)}" style="width:100%;height:auto;display:block">`,
    `<line x1="${MARGEN}" y1="${base}" x2="${ANCHO - MARGEN}" y2="${base}" stroke="${LINEA}" stroke-width="1"/>`,
    // El relleno de las entradas va tenue: la que se lee es la LÍNEA, el área solo da cuerpo.
    `<polygon points="${areaEntradas}" fill="${VERDE}" fill-opacity="0.10"/>`,
    `<polyline points="${puntos(entradas, maximo)}" fill="none" stroke="${VERDE}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`,
    // Las salidas van punteadas y no rellenas: dos áreas superpuestas se tapan entre sí y
    // el punteado las distingue incluso impreso en blanco y negro.
    `<polyline points="${puntos(salidas, maximo)}" fill="none" stroke="${ROJO}" stroke-width="1.5" stroke-dasharray="4 3" stroke-linejoin="round"/>`,
    '</svg>',
  ].join('');
}

/** Una fila del desglose, tal como la arma `report-sections`. */
export interface BarraDeCosto {
  category: string;
  total: number;
}

/**
 * Desglose de costos en barras horizontales.
 *
 * HORIZONTALES y no verticales porque la etiqueta es el nombre de una categoría salida del
 * Excel del cliente —"materia_prima", "servicios profesionales"— y en vertical eso obliga a
 * rotar el texto o a truncarlo. Al lado de la barra cabe entero y se lee de corrido.
 */
export function svgBarrasDeCosto(items: BarraDeCosto[], maxBarras = 6): string {
  const visibles = items.filter((i) => i.total > 0).slice(0, maxBarras);
  if (visibles.length === 0) return '';

  const maximo = Math.max(...visibles.map((i) => i.total));
  const altoFila = 26;
  const alto = visibles.length * altoFila + MARGEN;
  // Ancho fijo para la columna de etiquetas: alinear las barras entre sí es lo que permite
  // comparar de un vistazo, que es todo el punto de la figura.
  const anchoEtiqueta = 180;
  const anchoBarra = ANCHO - anchoEtiqueta - MARGEN * 2;

  const filas = visibles
    .map((item, i) => {
      const y = i * altoFila + MARGEN;
      const w = maximo <= 0 ? 0 : (item.total / maximo) * anchoBarra;
      const etiqueta = escaparXml(
        item.category.length > 26 ? `${item.category.slice(0, 25)}…` : item.category,
      );
      return [
        `<text x="0" y="${y + 13}" font-size="12" fill="${GRIS}" font-family="sans-serif">${etiqueta}</text>`,
        `<rect x="${anchoEtiqueta}" y="${y + 3}" width="${r2(w)}" height="14" rx="2" fill="${TINTA}" fill-opacity="0.82"/>`,
      ].join('');
    })
    .join('');

  return `<svg viewBox="0 0 ${ANCHO} ${alto}" role="img" style="width:100%;height:auto;display:block">${filas}</svg>`;
}
