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
 * ¿La fila `i` es TEXTO justo donde su propia columna es NÚMERO más abajo?
 *
 * ═══ LA SEÑAL QUE FALTABA, Y POR QUÉ EL PUNTAJE SOLO NO ALCANZA ═══
 *
 * `puntaje()` compara filas por sus rasgos ABSOLUTOS (cuánto texto, cuánta unicidad, cuánto
 * ancho). Eso funciona mientras las filas de datos sean pobres en texto, y se cae en cuanto la
 * tabla tiene columnas descriptivas. Caso real que lo destapó — `Concesionaria_Guatemala`,
 * CarsGT, 2026-08-24, las CINCO hojas del libro:
 *
 *   [0] ["Ventas"]                                              ← título, puntaje 0
 *   [2] ["ID Venta","Fecha","Cliente","Vendedor","ID Vehiculo",...]  ← el real, puntaje 1,00
 *   [3] ["V-0001", 45678, "Ana Lopez", "Luis Paz", "VH-001", ...]    ← datos,  puntaje 0,81
 *
 * Las filas de datos traen cliente, vendedor, VIN, marca, modelo, tipo y sucursal: siete
 * columnas de texto único. Su `unicos` y su `cobertura` dan 1,00 igual que las del encabezado,
 * así que el ÚNICO discriminante es `proporcionTexto`, que pesa 0,35. Con el margen de 0,2
 * exigido sobre las filas siguientes, el encabezado necesitaba 1,014 sobre un máximo de 1,00:
 * era imposible que ganara. Perdía por 0,014 y la hoja se quedaba con el título como
 * encabezado.
 *
 * El costo no fue leer mal una columna. Fue que TODO lo que se indexa contra la fila 0 dejó de
 * funcionar a la vez: `classifySheet` recibía `["Ventas"]` —una celda—, lo declaraba ilegible
 * y mandaba la hoja al modelo; con ella se cayeron el pre-filtro de catálogos, la firma de
 * `existencias` y la forma de hoja. Las cinco hojas del libro fueron al modelo, el inventario
 * no se reconoció, y el archivo costó USD 0,90 por cada mil filas: el más caro de la semana.
 *
 * ═══ POR QUÉ ESTA SEÑAL ES DISTINTA ═══
 *
 * No mide la fila contra un ideal de encabezado: la mide contra SUS PROPIOS DATOS. Un
 * encabezado dice "Fecha" donde su columna trae seriales, y "Precio Venta (Q)" donde trae
 * montos. Da igual cuánto texto tenga el resto de la tabla — lo que importa es que el
 * encabezado ROMPE el tipo de la columna, y una fila de datos no lo hace.
 *
 * Y conserva el sesgo de la casa: en una hoja donde todo es texto (un catálogo de nombres)
 * ninguna columna cambia de tipo, esto devuelve 0, y la detección se queda en la fila 0 sin
 * descartar un dato real.
 */
function rompeElTipoDeSusColumnas(rows: unknown[][], i: number, anchoMaximo: number): number {
  /*
   * Cinco filas y no una: un archivo real mete un subtotal o una fila a medio llenar justo
   * debajo del encabezado, y juzgar con una sola la convertiría en la referencia.
   */
  const siguientes = rows.slice(i + 1, i + 6);
  if (siguientes.length < 2) return 0;

  let rompe = 0;
  let comparables = 0;

  for (let c = 0; c < anchoMaximo; c++) {
    // Solo se juzgan las columnas donde el candidato dice algo: un hueco no es evidencia.
    if (!esTexto(rows[i]?.[c])) continue;

    const valores = siguientes.map((f) => f?.[c]).filter((v) => !vacia(v));
    // Una columna casi vacía abajo no distingue nada.
    if (valores.length < 2) continue;

    comparables++;
    if (valores.every((v) => !esTexto(v))) rompe++;
  }

  return comparables === 0 ? 0 : rompe / comparables;
}

/**
 * Cuántas de las columnas del candidato tienen que cambiar de tipo hacia abajo.
 *
 * Medido sobre las cinco hojas del archivo que motivó esto: 0,33 · 0,38 · 0,29 · 0,60 · 0,55.
 * El corte queda debajo de la más floja con margen, y bien lejos del 0 que da una hoja de puro
 * texto — que es el caso que NO debe disparar.
 */
const MIN_COLUMNAS_QUE_CAMBIAN_DE_TIPO = 0.25;

/** Cuántas celdas de la fila traen algo. Es el ANCHO ÚTIL, no `length`. */
const celdasLlenas = (fila: unknown[]): number => fila.filter((c) => !vacia(c)).length;

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * UNA FILA DE UNA CELDA NO ES EL ENCABEZADO DE UNA TABLA DE SEIS COLUMNAS
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *
 * Todo lo demás de este módulo compara filas por cómo se VEN —cuánto texto traen, si rompen el
 * tipo de su columna—. Esta señal es de otra naturaleza y por eso va antes: es GEOMÉTRICA. Una
 * fila que llena una celda no puede ser el encabezado de una tabla cuyo cuerpo llena seis, sin
 * importar qué diga, en qué idioma, ni de qué tipo sean los datos.
 *
 * ═══ EL CASO QUE LO DESTAPA, Y POR QUÉ NINGUNA OTRA SEÑAL LO VE ═══
 *
 * Una hoja de catálogo de clientes:
 *
 *     [0] ancho 1   "Catalogo de Clientes"                        ← el detector elegía ESTA
 *     [1] ancho 1   "Base de clientes"
 *     [2] ancho 6   ID Cliente · Nombre · Apellido · Email · …    ← el encabezado real
 *     [3] ancho 6   C-000 · Nombre0 · Apellido0 · c0@mail.com…
 *
 * Las dos vías que existían fallan las dos, y no por descuido:
 *
 *   · "verse más encabezado que las filas de abajo" no distingue nada cuando TODA la hoja es
 *     texto — el encabezado y los datos puntúan igual;
 *   · `rompeElTipoDeSusColumnas` devuelve 0 por construcción, porque ninguna columna cambia de
 *     tipo: "Telefono" es texto y "5555-0001" también.
 *
 * El comentario de ese bloque decía que quedarse en la fila 0 acá era el sesgo correcto,
 * "sin descartar un dato real". Y la premisa es cierta: no se descarta ningún dato. Lo que no
 * se evaluó es lo que cuesta quedarse: `classifySheet` recibe `["Catalogo de Clientes"]`, una
 * celda, lo declara ilegible y **se apagan a la vez el pre-filtro de catálogos, la firma de
 * existencias y la forma de hoja**. El catálogo entero va al modelo, se paga por él, y sus
 * filas quedan a un veredicto de distancia de convertirse en movimientos que el cliente nunca
 * tuvo. Es el mismo fallo en cascada que ya costó el archivo más caro de la semana, entrando
 * por otra puerta.
 *
 * ═══ POR QUÉ NO EXIGE "DESTACAR" ═══
 *
 * Cuando la fila 0 es geométricamente imposible, no hay nada que desempatar: ya sabemos que no
 * es el encabezado, y lo correcto es lo que haría una persona mirando la hoja — el encabezado
 * es la primera fila que llena la tabla. Exigirle además que "destaque" es lo que dejaba el
 * caso sin resolver.
 *
 * ═══ EL UMBRAL, Y POR QUÉ ES LA MITAD ═══
 *
 * Se exige cubrir la MITAD del ancho del cuerpo, no todo: un encabezado real puede traer
 * columnas sin nombre. Un título llena una celda de seis (0,17) y queda lejísimos; un
 * encabezado con un par de huecos queda holgadamente adentro. Y si la hoja no tiene cuerpo del
 * cual medir, la comprobación se desactiva sola en vez de adivinar.
 */
function anchoDelCuerpo(rows: unknown[][]): number {
  const muestras = rows
    .slice(1, 9)
    .map(celdasLlenas)
    .filter((n) => n > 0)
    .sort((a, b) => a - b);
  // Mediana y no promedio: una fila de subtotal a medio llenar no puede mover el ancho típico.
  return muestras.length === 0 ? 0 : muestras[Math.floor(muestras.length / 2)]!;
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

  /*
   * Antes que cualquier comparación: ¿puede la fila 0 ser el encabezado de esta tabla? Si
   * llena mucho menos que el cuerpo, es un título, y el encabezado es la primera fila que sí
   * lo llena. Ver el bloque de `anchoDelCuerpo` para el caso que lo motiva.
   */
  const anchoTabla = anchoDelCuerpo(rows);
  const cubreLaTabla = (fila: unknown[]) =>
    anchoTabla === 0 || celdasLlenas(fila) * 2 >= anchoTabla;

  if (!cubreLaTabla(rows[0] ?? [])) {
    /*
     * ═══════════════════════════════════════════════════════════════════════════════════════
     * ENTRE LAS FILAS QUE CUBREN LA TABLA GANA LA QUE MÁS SE PARECE A UN ENCABEZADO
     * ═══════════════════════════════════════════════════════════════════════════════════════
     *
     * Antes se devolvía **la primera** que cubriera, y `cubreLaTabla` acepta a partir de la
     * MITAD del ancho del cuerpo. Ese umbral es deliberadamente flojo porque un encabezado
     * real puede traer columnas sin nombre; el error era usarlo también para ELEGIR.
     *
     * Medido sobre un libro con la tabla en la columna E y tres filas de título arriba:
     *
     *     [0] "COMERCIALIZADORA XELA, S.A."                        1 celda
     *     [1] "NIT 7788990-1" · "Periodo: 2026"                    2 celdas
     *     [2] 2026 · 8 · "Hoja 1 de 1"                             3 celdas  ← se elegía ESTA
     *     [3] Fecha · Documento · Cliente · Monto · Monto · Moneda  6 celdas  ← el encabezado
     *
     * Con un cuerpo de 6 columnas, la fila de pie de página pasa el umbral (3 × 2 ≥ 6) y gana
     * por ser primera. El daño no es perder la hoja —eso se vería—: es que el mapa de columnas
     * se arma contra la fila equivocada y **los datos salen de las columnas de al lado**, con
     * cifras plausibles. Las 32 ventas del archivo entraron en cero.
     *
     * `puntaje` es justo el discriminante que hacía falta y ya estaba escrito: un título con
     * números da 0,40 y el encabezado 0,75, mientras una fila de datos —texto mezclado con
     * seriales y montos— da 0,60. No se sube el umbral de `cubreLaTabla` porque eso sí
     * rompería el caso legítimo del encabezado con huecos; se cambia solo el criterio de
     * DESEMPATE, y el empate se resuelve por la más temprana, que conserva el sesgo de casa.
     */
    let mejor = -1;
    let mejorPuntaje = -1;
    for (let i = 1; i < limite; i++) {
      if (!cubreLaTabla(rows[i]!)) continue;
      const p = puntaje(rows[i]!, anchoMaximo);
      if (p > mejorPuntaje) {
        mejor = i;
        mejorPuntaje = p;
      }
    }
    // Ninguna fila llena la tabla: no hay tabla que encontrar y se conserva el sesgo de casa.
    return mejor === -1 ? 0 : mejor;
  }

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

    /*
     * Tiene que ganarle a lo que ya teníamos Y destacar sobre lo que viene abajo. Los dos
     * márgenes son deliberados: sin ellos, cualquier fila un poco mejor movería el corte.
     *
     * La segunda condición se cumple de DOS formas, y la alternativa no la debilita: o el
     * candidato se ve bastante más encabezado que las filas de abajo (el camino original), o
     * ROMPE EL TIPO de sus propias columnas, que es evidencia más fuerte y no depende de
     * cuánto texto tenga la tabla. Sin la segunda vía, ninguna hoja con columnas descriptivas
     * podía encontrar su encabezado — ver la nota de `rompeElTipoDeSusColumnas`.
     */
    const rompeElTipo =
      rompeElTipoDeSusColumnas(rows, i, anchoMaximo) >= MIN_COLUMNAS_QUE_CAMBIAN_DE_TIPO;
    const destaca = p > promedioSiguientes + 0.2 || rompeElTipo;

    /*
     * ═══ EL MARGEN DE PUNTAJE NO APLICA CUANDO EL CANDIDATO ROMPE EL TIPO ═══
     *
     * El 0,15 existe para que una fila apenas mejor no mueva el corte, y para el camino
     * original sigue intacto — la condición de abajo es la misma de siempre cuando no hay
     * evidencia de tipo.
     *
     * Pero cuando el candidato ROMPE EL TIPO de sus columnas, ese margen deja de proteger y
     * pasa a estorbar. El puntaje mide "cuánto se parece esto a un encabezado" mirando la fila
     * sola; romper el tipo mide la fila CONTRA SUS PROPIOS DATOS, que es evidencia mucho más
     * específica. Cuando las dos se contradicen, gana la segunda.
     *
     * El caso: un título de ancho completo y puro texto —"Reporte | de | Ventas | 2025 |
     * Confidencial", o el "Empresa: | ACME | Periodo: | 2025" que exportan varios sistemas
     * contables— empata en puntaje con el encabezado real de abajo y le gana por ser primero.
     * La guarda geométrica no lo salva porque el título SÍ llena la tabla. Sin esto la hoja se
     * queda en la fila 0, que es el fallo en cascada que apaga el pre-filtro entero.
     */
    if (destaca && (rompeElTipo ? p >= mejorPuntaje : p > mejorPuntaje + 0.15)) {
      mejor = i;
      mejorPuntaje = p;
    }
  }

  return mejor;
}
