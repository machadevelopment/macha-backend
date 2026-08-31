/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * EL LIBRO DE EXCEL ES UNA BASE DE DATOS MAL NORMALIZADA. ESTO LEE SU ESQUEMA.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *
 * Hasta acá cada hoja se juzgaba SOLA: ¿tiene forma de tabla?, ¿sus encabezados son de
 * catálogo?, ¿suma lo mismo que otra hoja? Todo eso mira una hoja (o un par) y decide.
 *
 * Lo que ninguna de esas preguntas puede ver es que las hojas están UNIDAS POR
 * IDENTIFICADORES, y que esa unión dice qué hoja produce el hecho económico y cuál solo lo
 * describe o lo referencia. Un archivo real de concesionaria (CarsGT, 2026-08-24, documento
 * `bb769e8e`) lo mostró costando Q 16 millones de ingreso inventado:
 *
 *     Inventario         260 filas · `ID Vehiculo` ÚNICO por fila · Costo Adquisicion Q 36,4M
 *     Ventas             240 filas · `ID Vehiculo` → apunta al inventario (240 de 240)
 *     CuentasPorCobrar    81 filas · `ID Venta`    → apunta a Ventas   ( 81 de  81)
 *
 * Las tres se procesaron como libros de movimientos independientes. Resultado en el dashboard
 * del cliente:
 *
 *     ingresos    Q 38.843.310 reales  →  Q 54.825.290 mostrados   (+41 %)
 *     costos      Q 33.359.479 reales  →  Q 45.075.005 mostrados   (+35 %)
 *     inventario  260 vehículos        →  0 movimientos
 *
 * Los 260 vehículos EN STOCK entraron como costo de ventas —240 de ellos por segunda vez,
 * porque su costo ya venía en la hoja `Ventas`— y las 81 cuentas por cobrar volvieron a
 * reconocer un ingreso que la venta ya había reconocido.
 *
 * ═══ POR QUÉ POR ESTRUCTURA Y NO POR VOCABULARIO ═══
 *
 * La respuesta corta a este bug era agregar `vin`, `idvehiculo` y `costoadquisicion` a la
 * firma `existencias` de `sheet-classifier.ts`. Eso arregla las concesionarias y garantiza
 * que la joyería (`certificado`, `quilataje`), la inmobiliaria (`matricula`, `finca`) y la
 * distribuidora de maquinaria (`numeroserie`, `horometro`) vuelvan a fallar igual. La firma
 * existente busca vocabulario de inventario FUNGIBLE —`stock`, `cantidad disponible`, `punto
 * de reorden`, `unidad de medida`— porque nació de una cafetería; un negocio de inventario
 * SERIALIZADO no dice ninguna de esas palabras y no tiene por qué.
 *
 * Un identificador único por fila que otra hoja referencia, en cambio, es la misma señal en
 * todos los dominios. No hay que conocer el negocio para verla.
 *
 * ═══ LO QUE ESTE MÓDULO NO HACE ═══
 *
 * No decide qué hacer: devuelve el esquema y nada más. Quién produce movimientos, quién
 * puebla inventario y quién solo referencia lo resuelve el worker, que es donde está el
 * contexto contable. Acá solo se contesta "¿qué columnas son identificadores y quién apunta
 * a quién?".
 *
 * Tampoco reemplaza a `sheet-duplication.ts`. Ese detecta cabecera/detalle por SUMAS iguales
 * (`OrdenesCompra` = `LineasOC` = Q 2.707.318) y sigue siendo necesario: esas dos hojas no
 * comparten un identificador de fila, comparten el dinero. Son dos formas distintas de contar
 * dos veces y hacen falta las dos.
 */

/** Filas con el encabezado YA localizado en la posición 0 — igual que `sheet-duplication`. */
export interface HojaParaComparar {
  nombre: string;
  rows: unknown[][];
}

/**
 * Cuántos valores distintos hace falta ver para creer que dos columnas se refieren entre sí.
 *
 * Con pocos valores el solapamiento es barato por azar: dos hojas con una columna `Estado` de
 * tres valores (`Disponible`/`Vendido`/`Reservado`) se "referenciarían" mutuamente al 100 %.
 * El corte se combina con la exigencia de que la columna destino sea ÚNICA por fila, que es
 * lo que de verdad separa una clave de una etiqueta.
 *
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * BAJÓ DE 8 A 4 (2026-08-31), Y EL MOTIVO ES QUE APAGABA LA GUARDA JUSTO EN EL NEGOCIO CHICO
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *
 * Este número no solo decide relaciones: de él dependen DOS reglas sobre el dinero del
 * cliente —"una factura cuya venta ya está registrada no vuelve a devengar" y "un cobro no es
 * una venta nueva"— porque las dos preguntan al esquema del libro si la hoja apunta a otra.
 * Sin referencia detectada, las dos guardas no llegan a evaluarse.
 *
 * Con 8, una hoja de **6 cobros** contra facturas que ya se devengaron volvía a registrar su
 * ingreso: medido en `libro-la-ceiba.ts`, **+44,9 % de ingreso inventado**. Y esa es
 * exactamente la contabilidad de una PYME chica —seis recibos en el período es lo normal—,
 * así que la protección contra contar dos veces estaba apagada para quien menos puede
 * desmentirlo, y fallaba hacia ARRIBA, que es la dirección que parece una buena noticia.
 *
 * ═══ POR QUÉ 4 Y NO MENOS ═══
 *
 * El piso está MEDIDO, no elegido. Con 3 se pone en rojo el test que este mismo archivo ya
 * tenía —"con pocos valores no se afirma nada (el azar alcanza para cubrir)"—, que es la
 * defensa contra el falso positivo que el párrafo de arriba describe. 4 es el último valor
 * donde esa defensa sigue en pie.
 *
 * ═══ QUÉ SE MIDIÓ ANTES DE TOCARLO ═══
 *
 *   · Los 1.151 tests unitarios, incluido el corpus de 19 hojas de archivos reales: sin cambio.
 *   · Los DIEZ archivos reales de clientes (`~/Downloads/0*_*.xlsx`, los que CLAUDE.md exige
 *     correr antes de mergear cualquier cambio de ingesta): **veredicto idéntico hoja por
 *     hoja** entre 8 y 4, comparado con un diff.
 *
 * Lo que no cubre este número sigue cubierto por lo de siempre: el destino tiene que ser
 * ÚNICO por fila y la columna que apunta tiene que tener `CARDINALIDAD_MINIMA` de valores
 * distintos. El `Estado` de tres valores del ejemplo falla las dos, no ésta.
 */
const MIN_VALORES_PARA_RELACION = 4;

/**
 * Qué proporción de los valores de la columna que apunta tiene que existir del otro lado.
 *
 * No es 100 % a propósito: un archivo real trae filas nuevas que todavía no están en la tabla
 * maestra, y exigir totalidad haría que una sola fila reciente tumbara la detección de todo
 * el libro. 0,9 tolera eso sin acercarse al azar — que con ≥8 valores distintos y destino
 * único queda muy por debajo.
 */
const COBERTURA_MINIMA = 0.9;

/**
 * Qué proporción de valores DISTINTOS necesita una columna para ser candidata a identificador.
 *
 * Una columna de identificadores es casi toda distinta; una de categorías, casi toda repetida.
 * El corte va alto porque el costo de equivocarse es asimétrico: tomar una columna repetida
 * como identificador inventaría relaciones entre hojas que no existen, y de esas relaciones
 * dependen decisiones sobre el dinero del cliente.
 */
const CARDINALIDAD_MINIMA = 0.9;

/** Un identificador más largo que esto es una descripción, no una clave. */
const LARGO_MAXIMO_DE_CLAVE = 64;

/**
 * Rango de plausibilidad de una FECHA de Excel — el mismo que `sheet-duplication.ts` y
 * `row-assembly.ts`. Una columna de fechas tiene cardinalidad alta y valores cortos, o sea
 * que pasaría por identificador sin este filtro.
 */
const ES_SERIAL_DE_FECHA = (n: number): boolean => n >= 32_874 && n <= 73_415;

/**
 * Normaliza un valor de celda a la cadena con la que se compara entre hojas.
 *
 * Se compara en minúsculas y sin espacios de sobra porque el MISMO identificador se escribe
 * distinto en dos hojas del mismo libro con una frecuencia que sorprende (`VH-001` y `vh-001`).
 * No se quitan guiones ni puntos: forman parte de la clave y quitarlos acercaría claves que
 * son distintas.
 */
function comoClave(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return null;
    // Un monto con decimales no es una clave; un entero puede serlo (`1001`).
    if (!Number.isInteger(v)) return null;
    if (ES_SERIAL_DE_FECHA(v)) return null;
    return String(v);
  }
  if (v instanceof Date) return null;
  if (typeof v !== 'string') return null;
  const limpio = v.trim().toLowerCase();
  if (limpio === '' || limpio.length > LARGO_MAXIMO_DE_CLAVE) return null;
  return limpio;
}

/** Una columna que puede ser un identificador, con sus valores ya normalizados. */
interface ColumnaClave {
  indice: number;
  valores: Set<string>;
  /** Cuántas filas traen un valor utilizable. */
  presentes: number;
  /** `true` si no hay un solo valor repetido: es clave primaria de su hoja. */
  unica: boolean;
}

/**
 * Las columnas de una hoja que podrían ser identificadores.
 *
 * Devuelve varias a propósito: un archivo de PYME rara vez marca cuál es la clave, y la
 * columna que relaciona dos hojas no tiene por qué ser la primera ni llamarse `ID`.
 */
function columnasClave(rows: unknown[][]): ColumnaClave[] {
  const datos = rows.slice(1);
  if (datos.length === 0) return [];

  const ancho = Math.max(0, ...rows.map((f) => f.length));
  const out: ColumnaClave[] = [];

  for (let c = 0; c < ancho; c++) {
    const valores = new Set<string>();
    let presentes = 0;

    for (const f of datos) {
      const k = comoClave(f[c]);
      if (k === null) continue;
      presentes++;
      valores.add(k);
    }

    // Una columna medio vacía no es la clave de nada.
    if (presentes < datos.length * COBERTURA_MINIMA) continue;
    if (valores.size < MIN_VALORES_PARA_RELACION) continue;
    if (valores.size < presentes * CARDINALIDAD_MINIMA) continue;

    out.push({ indice: c, valores, presentes, unica: valores.size === presentes });
  }

  return out;
}

/** Una hoja apunta a otra: sus valores viven en la clave de la otra. */
export interface Referencia {
  /** La hoja que APUNTA (la que trae la clave foránea). */
  desde: string;
  desdeColumna: number;
  /** La hoja APUNTADA (la que tiene esa clave como propia y única). */
  hacia: string;
  haciaColumna: number;
  /** Qué proporción de los valores de `desde` existen en `hacia`. */
  cobertura: number;
  /** Cuántos valores distintos sostienen la relación. */
  valores: number;
}

export interface EsquemaDelLibro {
  referencias: Referencia[];
  /**
   * Hojas que son TABLA DE ENTIDADES: tienen una clave única por fila y alguien la
   * referencia. Describen cosas que existen, no hechos que ocurrieron.
   */
  entidades: Set<string>;
  /** Hojas que apuntan a otra hoja del libro. */
  referencian: Set<string>;
}

/**
 * Lee el esquema implícito del libro.
 *
 * Coste: para cada par ordenado de hojas compara sus columnas candidatas, que son pocas
 * (una hoja de PYME tiene una o dos columnas con cardinalidad de clave). El trabajo pesado
 * —normalizar cada celda— se hace UNA vez por hoja, no una vez por par.
 */
export function analizarEsquema(hojas: HojaParaComparar[]): EsquemaDelLibro {
  const claves = new Map<string, ColumnaClave[]>();
  for (const h of hojas) claves.set(h.nombre, columnasClave(h.rows));

  const referencias: Referencia[] = [];

  for (const desde of hojas) {
    for (const hacia of hojas) {
      if (desde.nombre === hacia.nombre) continue;

      for (const cd of claves.get(desde.nombre) ?? []) {
        for (const ch of claves.get(hacia.nombre) ?? []) {
          /*
           * El destino tiene que ser ÚNICO por fila. Sin esta condición la relación es
           * simétrica y no dice nada: dos hojas que comparten valores se apuntarían entre sí
           * y no habría forma de saber cuál describe y cuál referencia.
           */
          if (!ch.unica) continue;

          let dentro = 0;
          for (const v of cd.valores) if (ch.valores.has(v)) dentro++;
          const cobertura = dentro / cd.valores.size;
          if (cobertura < COBERTURA_MINIMA) continue;

          /*
           * Si las dos columnas son únicas y se cubren mutuamente, la relación es 1:1 y
           * ninguna "referencia" a la otra: son la misma lista escrita dos veces. Eso es
           * duplicación de otra clase y la resuelve `sheet-duplication.ts` comparando dinero.
           */
          if (cd.unica && cd.valores.size === ch.valores.size && cobertura === 1) continue;

          referencias.push({
            desde: desde.nombre,
            desdeColumna: cd.indice,
            hacia: hacia.nombre,
            haciaColumna: ch.indice,
            cobertura,
            valores: cd.valores.size,
          });
        }
      }
    }
  }

  const utiles = resolverDireccion(referencias);
  const referencian = new Set(utiles.map((r) => r.desde));

  /*
   * ═══ SER REFERENCIADA NO BASTA: UNA TABLA MAESTRA ES TERMINAL ═══
   *
   * `Ventas` también es destino de una referencia (`CuentasPorCobrar` apunta a ella), y
   * `Ventas` es justamente el libro de movimientos que NO hay que silenciar. Lo que separa a
   * las dos es la dirección del grafo completo: `Inventario` recibe y no emite —nada de lo que
   * contiene depende de otra hoja—, mientras `Ventas` recibe de CxC y emite hacia Inventario.
   *
   * Un catálogo es la hoja donde el libro TERMINA: describe cosas que existen por su cuenta.
   * Un evento apunta a las cosas que usó.
   */
  const entidades = new Set(
    utiles.map((r) => r.hacia).filter((nombre) => !referencian.has(nombre)),
  );

  return { referencias: utiles, entidades, referencian };
}

/**
 * Deja UNA dirección por cada par de hojas: la que apunta a la tabla que CONTIENE a la otra.
 *
 * ═══ POR QUÉ HACE FALTA ═══
 *
 * Entre `Ventas` e `Inventario` la detección encuentra las dos direcciones, porque las dos
 * columnas son únicas en su hoja y se solapan de sobra:
 *
 *     Ventas.ID Vehiculo    → Inventario.ID Vehiculo   100 %   (240 valores)
 *     Inventario.ID Vehiculo → Ventas.ID Vehiculo        92 %   (260 valores)
 *
 * Sin desempatar, las dos hojas quedan marcadas como tabla de entidades y la señal no sirve
 * para nada: justamente lo que hay que decidir es cuál de las dos describe cosas y cuál
 * registra hechos.
 *
 * ═══ LA REGLA, Y POR QUÉ ES LA CORRECTA ═══
 *
 * La entidad es el SUPERCONJUNTO. Toda venta tiene su vehículo —por eso cubre 100 %— pero no
 * todo vehículo se vendió: los 20 que siguen en el patio hacen que la dirección contraria se
 * quede en 92 %. Esa asimetría no es ruido, es la definición de la relación: el inventario
 * existe con independencia de que haya venta, y la venta no existe sin el vehículo.
 *
 * Cuando ni siquiera eso desempata (misma cobertura en las dos direcciones), no se conserva
 * ninguna. Una relación ambigua entre dos hojas de dinero es exactamente el caso donde
 * equivocarse sale caro, y el sesgo de todo este pipeline es no actuar sin evidencia.
 */
function resolverDireccion(referencias: Referencia[]): Referencia[] {
  /** `hojaA\0hojaB` con las dos hojas ordenadas: la misma clave para las dos direcciones. */
  const porPar = new Map<string, Referencia[]>();
  for (const r of referencias) {
    const k = [r.desde, r.hacia].sort().join('\u0000');
    const l = porPar.get(k);
    if (l) l.push(r);
    else porPar.set(k, [r]);
  }

  const out: Referencia[] = [];

  for (const grupo of porPar.values()) {
    /*
     * La mejor de cada dirección. Un mismo par de hojas puede relacionarse por VARIAS
     * columnas —este archivo lo hace por `ID Vehiculo` y por `VIN`— y son la misma relación
     * dicha dos veces: conservarlas todas multiplicaría el peso de un solo hecho.
     */
    const mejorDe = (desde: string): Referencia | undefined =>
      grupo
        .filter((r) => r.desde === desde)
        .sort((a, b) => b.cobertura - a.cobertura || b.valores - a.valores)[0];

    const nombres = [...new Set(grupo.map((r) => r.desde))];
    if (nombres.length === 1) {
      const u = mejorDe(nombres[0]!);
      if (u) out.push(u);
      continue;
    }

    const a = mejorDe(nombres[0]!);
    const b = mejorDe(nombres[1]!);
    if (!a || !b) continue;
    if (a.cobertura === b.cobertura) continue; // ambigua: no se conserva ninguna
    out.push(a.cobertura > b.cobertura ? a : b);
  }

  return out;
}

/**
 * ¿Esta hoja es una tabla de ENTIDADES referenciada por otra?
 *
 * Es la pregunta que separa `Inventario` (260 vehículos que EXISTEN) de `Ventas` (240 hechos
 * que OCURRIERON), sin saber nada de vehículos.
 */
export function esTablaDeEntidades(esquema: EsquemaDelLibro, hoja: string): boolean {
  return esquema.entidades.has(hoja);
}

/**
 * Las hojas a las que ESTA hoja apunta.
 *
 * Sirve para la otra mitad del problema: una fila de `CuentasPorCobrar` que apunta a una
 * venta ya registrada no vuelve a reconocer ese ingreso.
 */
export function referenciasDe(esquema: EsquemaDelLibro, hoja: string): Referencia[] {
  return esquema.referencias.filter((r) => r.desde === hoja);
}
