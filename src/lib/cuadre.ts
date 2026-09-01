/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * ¿LO QUE ATERRIZÓ SE PARECE A LO QUE EL ARCHIVO DECÍA? — EL LAZO QUE FALTABA CERRAR
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *
 * `lib/reconciliation.ts` mide cuánto dinero traía cada hoja y lo escribe en el resumen. Nadie
 * lo compara nunca contra lo que quedó en el ledger, así que el lazo está abierto: la medición
 * existe, el resultado existe, y no hay nada que note cuando no se parecen.
 *
 * Eso importa más que cualquier test, y por un motivo que costó siete reportes entender: **los
 * tests cubren archivos que ya vimos.** Este chequeo es lo único que funciona sobre uno que
 * nadie vio nunca — el que va a subir el próximo cliente.
 *
 * ═══ POR QUÉ NO ES UN CUADRE EXACTO ═══
 *
 * `reconciliation.ts` ya lo explica y sigue vigente: **una fila del archivo produce
 * legítimamente MÁS de una fila del ledger**. Una venta con su costo en la misma línea produce
 * dos transacciones; una factura emitida produce su cuenta por cobrar Y su ingreso devengado;
 * una factura recibida produce su cuenta por pagar Y su costo. Un cuadre ingenuo marcaría cada
 * una de esas cargas como descuadrada.
 *
 * Y sin embargo el chequeo sirve, porque **los fallos reales no son de 1,02×**. Medidos sobre
 * los dieciséis bugs encontrados en la ingesta:
 *
 *     hoja de gastos descartada por forma      75.465  →       0     ×0
 *     nómina con fechas en español             88.800  →       0     ×0
 *     hoja exportada en MM/DD/YYYY            176 movs →       0     ×0
 *     matriz trimestral / semestral            77.280  →       0     ×0
 *     resumen mensual procesado como detalle        X  →      2X     ×2
 *     copia de respaldo procesada                   X  →      2X     ×2
 *     cobros contados como ventas nuevas      238.387  → 362.819   ×1,52
 *
 * Ninguno cae dentro de una banda razonable. Un umbral tolerante los atrapa a todos sin
 * disparar con las expansiones legítimas.
 *
 * ═══ NO BLOQUEA, Y ESO ES DECISIÓN ═══
 *
 * `evaluar` clasifica y NADA MÁS. Un falso positivo que frene la promoción deja al cliente sin
 * su contabilidad por un chequeo que se equivocó, que es peor que el problema que viene a
 * resolver. El primer paso es registrar el veredicto en cada carga y mirar la distribución real
 * durante unas semanas; endurecerlo hoy sería adivinar, que es exactamente lo que
 * `reconciliation.ts` decidió no hacer.
 *
 * Lo que sí cambia desde ya: un `descuadre` queda ESCRITO en el resumen de la carga, así que
 * cuando un cliente reporta "esto no cuadra" la respuesta ya está registrada en vez de haber
 * que reconstruirla a mano.
 */

/** Lo medido en el archivo, por moneda. */
export interface LeidoDelArchivo {
  moneda: string;
  /** Suma de la columna de monto sobre las filas que se enviaron a clasificar. */
  monto: number;
  /** Suma de la columna de costo, cuando la hoja la trae aparte. */
  costo: number;
}

/** Lo que quedó en el ledger para esa carga, por moneda. */
export interface AterrizadoEnElLedger {
  moneda: string;
  /** Suma de los montos de todas las filas promovidas (transacciones, facturas y deudas). */
  monto: number;
}

export type Veredicto =
  /** Lo aterrizado está dentro de la banda esperada. */
  | 'cuadra'
  /**
   * Lo que falta está esperando en revisión interna, no perdido.
   *
   * Es un estado NORMAL y distinto de `falta`, y separarlos importa porque piden acciones
   * opuestas: esto necesita que alguien mire la cola de revisión —el trabajo ya está
   * identificado y tiene dueño—, mientras que `falta` necesita que alguien mire el pipeline
   * porque hay plata que nadie sabe dónde quedó. Meterlos en el mismo cajón haría que el
   * segundo, que es el caro, se pierda entre decenas del primero, que es rutina.
   */
  | 'en_revision'
  /** No aterrizó NADA habiendo dinero en el archivo. El fallo más caro y más frecuente. */
  | 'nada_aterrizo'
  /** Aterrizó bastante menos de lo que el archivo traía. */
  | 'falta'
  /** Aterrizó bastante más: casi siempre, la misma plata contada dos veces. */
  | 'sobra'
  /** El archivo no traía dinero medible: no hay nada que comparar. */
  | 'sin_datos'
  /**
   * La hoja NO se registra a propósito porque el libro ya cuenta ese dinero en otra hoja.
   *
   * Es un estado CORRECTO, no un descuadre, y necesita veredicto propio porque su forma es
   * idéntica a la del fallo más caro: cero aterrizado habiendo dinero en el archivo. Sin esto,
   * `evaluarCuadre` dice `nada_aterrizo` sobre una hoja de COBROS —que por diseño no vuelve a
   * contar el ingreso de su factura— y ese es un falso positivo GARANTIZADO en todo libro que
   * lleve cobros, que son la mayoría. Medido el 2026-09-01 en `12-la-ceiba.xlsx`: la carga
   * salió con las tres cifras exactas contra la verdad de campo y el cuadre igual gritó
   * DESCUADRE. Un detector que se equivoca sobre lo correcto enseña a ignorarlo, y entonces no
   * sirve el día que acierta.
   */
  | 'no_se_registra';

export interface Cuadre {
  moneda: string;
  leido: number;
  aterrizado: number;
  /** `aterrizado / leido`. `null` cuando no hay nada leído contra qué comparar. */
  razon: number | null;
  veredicto: Veredicto;
  /** En lenguaje de operador, para el log y el resumen de la carga. */
  detalle: string;
}

/**
 * Cota INFERIOR de la banda.
 *
 * Por debajo de esto falta plata. No es 1,0 porque hay pérdidas legítimas y acotadas: una fila
 * marcada que se queda en revisión, un renglón de TOTAL que el modelo declara `skip`, una fila
 * sin fecha legible. Ninguna de esas se lleva el 10 % de una hoja; los fallos reales se llevan
 * el 100 %.
 */
const MINIMO = 0.9;

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA COTA SUPERIOR SE CALCULA, NO SE ELIGE — Y ESTO ES LO QUE HACE ÚTIL AL DETECTOR
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *
 * El primer intento fue un número fijo, y no funciona: hay una tensión imposible entre los dos
 * lados. Una expansión legítima llega a 3× (una factura con costo en la línea produce la
 * factura, su ingreso devengado y el costo), pero el duplicado que hay que atrapar es ×2 y el
 * de los cobros es ×1,52. Cualquier constante o deja pasar los fallos o marca las cargas
 * normales.
 *
 * La salida es que la expansión **no es un misterio: el pipeline sabe exactamente cuántas
 * filas de ledger produjo por cada fila del archivo**, porque él mismo las creó. Esa cifra
 * (`expansion`) se pasa como dato, y la cota se deriva de ella con un margen chico.
 *
 * Con eso, el detector deja de adivinar:
 *
 *   · una carga que no expande nada (expansion 1,0) → banda hasta 1,15 → **atrapa el ×2**;
 *   · una carga de facturas con costo (expansion 3,0) → banda hasta 3,45 → no dispara;
 *   · y si la expansión declarada no coincide con lo aterrizado, eso ES el descuadre.
 *
 * O sea que la pregunta pasa de "¿cuánto es demasiado?" —que no tiene respuesta general— a
 * "¿lo aterrizado se parece a lo que este pipeline dijo que iba a producir?", que sí la tiene.
 *
 * El margen del 15 % absorbe las filas marcadas y los renglones de TOTAL; no absorbe un ×2.
 */
const MARGEN = 0.15;

/** Debajo de esto se considera que no aterrizó nada, aunque no sea exactamente cero. */
const CASI_NADA = 0.02;

/**
 * Compara lo leído contra lo aterrizado, moneda por moneda.
 *
 * ⚠️ **Por moneda y nunca sumado.** Un dólar contado como quetzal subestima ~7,7 veces, así que
 * un total mezclado escondería exactamente el tipo de error que esto busca — de hecho el bug de
 * `asCurrency` (una fila en EUR guardada como GTQ) solo es visible mirando cada moneda aparte.
 * Es la misma regla que ya gobierna la pantalla de conceptos pendientes y el resumen de lectura.
 */
export function evaluarCuadre(
  leido: LeidoDelArchivo[],
  aterrizado: AterrizadoEnElLedger[],
  /**
   * Cuántas filas de ledger produjo el pipeline por cada fila del archivo que midió.
   *
   * Lo sabe con certeza porque él mismo las creó: `filas del ledger / filas medidas`. Ver el
   * bloque de `MARGEN` — es lo que convierte la cota superior de una adivinanza en un cálculo.
   * `1` (sin expansión) es el default seguro: da la banda más estrecha, o sea la que más
   * descuadres reporta, y este detector no bloquea nada.
   */
  expansion = 1,
  /**
   * Lo que quedó en staging esperando revisión, por moneda. No está perdido: está
   * identificado y con dueño, y va a entrar en cuanto alguien lo resuelva. Ver `en_revision`.
   */
  enRevision: AterrizadoEnElLedger[] = [],
): Cuadre[] {
  const porMoneda = new Map<string, { leido: number; aterrizado: number; revision: number }>();
  const vacio = () => ({ leido: 0, aterrizado: 0, revision: 0 });
  for (const l of leido) {
    const previo = porMoneda.get(l.moneda) ?? vacio();
    // El costo cuenta como dinero leído: produce su propia fila en el ledger.
    previo.leido += l.monto + l.costo;
    porMoneda.set(l.moneda, previo);
  }
  for (const a of aterrizado) {
    const previo = porMoneda.get(a.moneda) ?? vacio();
    previo.aterrizado += a.monto;
    porMoneda.set(a.moneda, previo);
  }
  for (const r of enRevision) {
    const previo = porMoneda.get(r.moneda) ?? vacio();
    previo.revision += r.monto;
    porMoneda.set(r.moneda, previo);
  }

  const salida: Cuadre[] = [];
  for (const [moneda, { leido: l, aterrizado: a, revision: rev }] of porMoneda) {
    if (l <= 0) {
      salida.push({
        moneda,
        leido: l,
        aterrizado: a,
        razon: null,
        veredicto: 'sin_datos',
        detalle:
          a > 0
            ? `aterrizó ${moneda} ${a.toFixed(2)} sin que el archivo trajera un monto medible`
            : `el archivo no traía montos medibles en ${moneda}`,
      });
      continue;
    }

    const razon = a / l;
    let veredicto: Veredicto;
    let detalle: string;
    /*
     * Lo que falta, ¿está en revisión? Se mira ANTES que cualquier otro veredicto de falta,
     * porque una carga con filas pendientes no tiene nada malo: el dinero está identificado y
     * va a entrar en cuanto alguien las resuelva.
     */
    if (rev > 0 && (a + rev) / l >= MINIMO && razon < MINIMO) {
      salida.push({
        moneda,
        leido: l,
        aterrizado: a,
        razon,
        veredicto: 'en_revision',
        detalle:
          `${moneda} ${a.toFixed(2)} en el dashboard y ${rev.toFixed(2)} esperando revisión, ` +
          `sobre ${l.toFixed(2)} leídos: no falta nada, falta resolverlo`,
      });
      continue;
    }
    if (razon < CASI_NADA) {
      veredicto = 'nada_aterrizo';
      detalle =
        `el archivo traía ${moneda} ${l.toFixed(2)} y NO llegó nada al dashboard. ` +
        'Casi siempre es una hoja entera descartada antes del modelo';
    } else if (razon < MINIMO) {
      veredicto = 'falta';
      detalle =
        `el archivo traía ${moneda} ${l.toFixed(2)} y llegaron ${a.toFixed(2)} ` +
        `(${Math.round(razon * 100)} %): falta contabilidad del cliente`;
    } else if (razon > Math.max(expansion, 1) * (1 + MARGEN)) {
      veredicto = 'sobra';
      detalle =
        `el archivo traía ${moneda} ${l.toFixed(2)} y llegaron ${a.toFixed(2)} ` +
        `(${razon.toFixed(2)}×, y el pipeline solo expandió ${expansion.toFixed(2)}×): ` +
        'casi siempre es la misma plata contada dos veces';
    } else {
      veredicto = 'cuadra';
      detalle = `${moneda} ${a.toFixed(2)} sobre ${l.toFixed(2)} leídos (${razon.toFixed(2)}×)`;
    }
    salida.push({ moneda, leido: l, aterrizado: a, razon, veredicto, detalle });
  }
  return salida;
}

/** `true` si algún cuadre amerita que alguien lo mire. */
export function hayDescuadre(cuadres: Cuadre[]): boolean {
  return cuadres.some(
    (c) => c.veredicto !== 'cuadra' && c.veredicto !== 'sin_datos' && c.veredicto !== 'en_revision',
  );
}

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * EL MISMO CUADRE, PERO POR HOJA — PORQUE EL DEL DOCUMENTO SE DEJA ENGAÑAR
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *
 * `evaluarCuadre` suma el documento entero, y ahí tiene un agujero que se ve en cuanto se
 * escribe: **un libro donde una hoja aterriza el DOBLE y otra aterriza CERO cuadra perfecto**,
 * porque los dos errores se cancelan en el total. Y esa es exactamente la forma de los fallos
 * que llevamos meses persiguiendo:
 *
 *   · KapePrueba — el dedup conservó un resumen de 11 filas y descartó `Ventas` (481) y
 *     `Compras` (43); la única cifra que llegó fueron Q 13.362 de una cartera de clientes
 *     leída como ingresos. Dos hojas en cero y una inventando: el total no lo delata.
 *   · CarsGT — 81 cuentas por cobrar devengaron un ingreso que `Ventas` ya había contado,
 *     mientras el inventario entraba como costo. De nuevo, dos errores de signo opuesto.
 *
 * Por hoja no se cancelan. Cada hoja se compara contra lo que ELLA traía, así que una que
 * pierde su plata dice `nada_aterrizo` aunque la de al lado esté duplicando.
 *
 * ═══ POR QUÉ SE MIDE CONTRA `staging_rows` Y NO CONTRA EL LEDGER ═══
 *
 * Porque el ledger no sabe de qué hoja vino cada fila: `transactions` guarda `document_id`, no
 * `sheet_name`. `staging_rows` sí, desde la migración 0039, y además guarda el monto en la
 * moneda ORIGINAL — o sea que la comparación no arrastra el ruido de la conversión de moneda.
 *
 * Los dos cuadres son complementarios y hay que conservar los dos: éste atrapa los fallos de
 * COMPOSICIÓN entre hojas; el del documento, que sí lee el ledger, atrapa que la promoción no
 * haya escrito lo que staging decía.
 */
export interface CuadreDeHoja {
  hoja: string;
  cuadres: Cuadre[];
}

/** Lo medido y lo aterrizado de UNA hoja, listo para cuadrar. */
export interface HojaParaCuadrar {
  hoja: string;
  leido: LeidoDelArchivo[];
  aterrizado: AterrizadoEnElLedger[];
  /** Filas de staging producidas / filas del archivo medidas. Ver `evaluarCuadre`. */
  expansion?: number;
  enRevision?: AterrizadoEnElLedger[];
  /**
   * El esquema del libro demostró que esta hoja repite dinero ya registrado en otra
   * (`ventaYaRegistradaEnOtraHoja` / `compraYaRegistradaEnOtraHoja`), así que la ingesta
   * suprimió sus filas A PROPÓSITO. Que no aterrice nada es el resultado correcto.
   */
  suprimida?: boolean;
}

export function evaluarCuadrePorHoja(hojas: HojaParaCuadrar[]): CuadreDeHoja[] {
  return hojas.map((h) => {
    const cuadres = evaluarCuadre(h.leido, h.aterrizado, h.expansion ?? 1, h.enRevision ?? []);
    if (!h.suprimida) return { hoja: h.hoja, cuadres };

    /*
     * La hoja está suprimida por diseño: lo que NO llegó es el resultado correcto, no plata
     * perdida. Se reetiqueta en vez de omitirla, porque el veredicto igual se PERSISTE y quien
     * abra la cola tiene que poder leer qué pasó con esa hoja — omitirla la volvería invisible,
     * que es el problema opuesto.
     *
     * `sobra` NO se reetiqueta: que una hoja suprimida aterrice dinero significa que la
     * supresión no funcionó, y eso sí es un fallo — el doble conteo que la regla existe para
     * evitar.
     */
    return {
      hoja: h.hoja,
      cuadres: cuadres.map((c) =>
        c.veredicto === 'nada_aterrizo' || c.veredicto === 'falta'
          ? {
              ...c,
              veredicto: 'no_se_registra' as const,
              detalle:
                `el archivo traía ${c.moneda} ${c.leido.toFixed(2)} y NO se registra a ` +
                `propósito: el libro ya cuenta ese dinero en otra hoja`,
            }
          : c,
      ),
    };
  });
}

/** Las hojas que ameritan que alguien las mire, con su motivo ya redactado. */
export function hojasDescuadradas(porHoja: CuadreDeHoja[]): { hoja: string; detalle: string }[] {
  const out: { hoja: string; detalle: string }[] = [];
  for (const h of porHoja) {
    for (const c of h.cuadres) {
      if (
        c.veredicto === 'cuadra' ||
        c.veredicto === 'sin_datos' ||
        c.veredicto === 'en_revision' ||
        // Ver el veredicto: no aterrizar es su resultado correcto.
        c.veredicto === 'no_se_registra'
      )
        continue;
      out.push({ hoja: h.hoja, detalle: `${c.veredicto}: ${c.detalle}` });
    }
  }
  return out;
}
