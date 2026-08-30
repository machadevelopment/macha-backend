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
  /** No aterrizó NADA habiendo dinero en el archivo. El fallo más caro y más frecuente. */
  | 'nada_aterrizo'
  /** Aterrizó bastante menos de lo que el archivo traía. */
  | 'falta'
  /** Aterrizó bastante más: casi siempre, la misma plata contada dos veces. */
  | 'sobra'
  /** El archivo no traía dinero medible: no hay nada que comparar. */
  | 'sin_datos';

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
): Cuadre[] {
  const porMoneda = new Map<string, { leido: number; aterrizado: number }>();
  for (const l of leido) {
    const previo = porMoneda.get(l.moneda) ?? { leido: 0, aterrizado: 0 };
    // El costo cuenta como dinero leído: produce su propia fila en el ledger.
    previo.leido += l.monto + l.costo;
    porMoneda.set(l.moneda, previo);
  }
  for (const a of aterrizado) {
    const previo = porMoneda.get(a.moneda) ?? { leido: 0, aterrizado: 0 };
    previo.aterrizado += a.monto;
    porMoneda.set(a.moneda, previo);
  }

  const salida: Cuadre[] = [];
  for (const [moneda, { leido: l, aterrizado: a }] of porMoneda) {
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
  return cuadres.some((c) => c.veredicto !== 'cuadra' && c.veredicto !== 'sin_datos');
}
