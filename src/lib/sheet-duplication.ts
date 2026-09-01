/**
 * Detecta cuando DOS hojas del mismo libro describen EL MISMO DINERO.
 *
 * ═══ EL RIESGO, MEDIDO ═══
 *
 * Un archivo real de cliente (2026-08-14) trae las compras dos veces:
 *
 *   OrdenesCompra:  60 filas · MontoTotal = 2.707.318,00
 *   LineasOC:      220 filas · TotalLinea = 2.707.318,00     ← la MISMA plata
 *
 * La orden OC-0001 vale 48.610 y sus tres líneas suman exactamente 48.610. Es una cabecera y
 * su detalle: el mismo hecho económico a dos granularidades.
 *
 * Si las dos hojas producen movimientos, las compras del cliente se cuentan DOS VECES —
 * Q 5,4 millones donde hay 2,7. En un producto contable eso no es un bug más: es el número
 * que el dueño usa para decidir.
 *
 * ═══ POR QUÉ ESTO ESTÁ ESCRITO Y NO SOLO ARREGLADO ═══
 *
 * Hoy no pasa, pero por ACCIDENTE: las filas de `LineasOC` no traen proveedor —vive en la
 * hoja padre— así que se marcan `missing_counterparty` y no se promueven. El plan obvio era
 * "unir el proveedor de la cabecera para que dejen de marcarse". Ese arreglo, que suena a
 * mejora, habría duplicado las compras del cliente.
 *
 * Por eso la detección va acá, explícita, en vez de depender de que una validación de otra
 * cosa nos siga salvando.
 *
 * ═══ CUÁL SE CONSERVA Y POR QUÉ ═══
 *
 * La CABECERA, no el detalle. Tres razones, en orden de peso:
 *   1. sus filas se bastan solas: traen contraparte y fecha, que es lo que el detalle no tiene;
 *   2. es el documento que de verdad genera la obligación de pagar;
 *   3. son menos filas, así que además cuesta menos procesarla.
 *
 * Se pierde el desglose por producto de la compra. Es una pérdida real y hay que decirla:
 * a cambio, el total que ve el cliente es el correcto. Duplicar para conservar el detalle
 * sería cambiar un dato bueno por dos malos.
 */

import { pareceLibroDeMovimientos } from './sheet-classifier';
import { asDate } from './row-assembly';

/** Convierte a número lo que Excel entrega como número o como texto con separadores. */
function aNumero(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string') return null;
  const limpio = v.replace(/[^0-9.,-]/g, '').trim();
  if (limpio === '') return null;
  const ultimaComa = limpio.lastIndexOf(',');
  const ultimoPunto = limpio.lastIndexOf('.');
  const n = Number(
    ultimaComa > ultimoPunto
      ? limpio.replace(/\./g, '').replace(',', '.')
      : limpio.replace(/,/g, ''),
  );
  return Number.isFinite(n) ? n : null;
}

const normalizar = (v: unknown): string =>
  String(v ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\([^)]*\)/g, ' ')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');

export interface HojaParaComparar {
  nombre: string;
  /** Filas con el encabezado YA localizado en la posición 0. */
  rows: unknown[][];
  /**
   * Los CONCEPTOS de una hoja que salió de despivotar una matriz por período.
   *
   * ═══ POR QUÉ HACE FALTA: EL CHEQUEO DE ENCABEZADOS SE VUELVE VACÍO ═══
   *
   * Exigir que dos hojas compartan un encabezado es la condición que evita el falso positivo
   * caro: dos hojas sin nada en común pueden sumar parecido por casualidad, y descartar una
   * perdería contabilidad real. Pero una hoja despivotada tiene encabezados **sintéticos** —
   * siempre `Fecha · Concepto · Monto`—, así que DOS despivotadas comparten los tres por
   * construcción y el chequeo deja de aportar evidencia. Quedan comparándose solo por la suma,
   * que es exactamente lo que la condición vino a impedir.
   *
   * Encontrado con dos matrices de gastos sin relación —una trimestral y una mensual— cuyos
   * totales coincidieron: una se descartó entera.
   *
   * Cuando las DOS traen conceptos, el solape se mide sobre ellos: dos matrices de los mismos
   * gastos nombran los mismos rubros, y dos de gastos distintos no. Si solo una es despivotada,
   * o ninguna, se sigue comparando por encabezados como siempre.
   */
  conceptos?: ReadonlySet<string>;
  /**
   * `false` si OTRO filtro del pipeline va a descartar esta hoja igual.
   *
   * Una hoja así NUNCA puede ser la conservada: ver el bloque "LA CONSERVADA TIENE QUE
   * SOBREVIVIR" abajo. Se omite por defecto (`true`) para no obligar a todos los llamadores
   * a calcularlo, pero el worker SÍ lo pasa.
   */
  puedeProducirMovimientos?: boolean;
}

/**
 * Rango de plausibilidad de una FECHA de Excel, el mismo que usa `row-assembly.ts`:
 * 32.874 = 1990-01-01 y 73.415 = 2101-01-01.
 */
const ES_SERIAL_DE_FECHA = (n: number): boolean => n >= 32_874 && n <= 73_415;

/**
 * Sumas de las columnas que pueden ser DINERO, todas, no solo la mayor.
 *
 * ═══ POR QUÉ SE EXCLUYEN LAS FECHAS, Y NO ES UN DETALLE ═══
 *
 * Un serial de Excel vale ~45.000. Sesenta fechas suman 2.764.944 — MÁS que los 2.707.318 de
 * la columna de dinero de esa misma hoja. La primera versión de esto tomaba "la suma más
 * grande" y elegía la fecha de entrega como si fuera el total de las compras, así que la
 * comparación entre hojas fallaba por 2 % y no detectaba nada.
 *
 * ═══ Y POR QUÉ TODAS Y NO LA MAYOR ═══
 *
 * Las dos hojas nombran su total distinto ("MontoTotal" contra "TotalLinea") y no tienen por
 * qué ser la columna más grande de su hoja. Comparar todas contra todas encuentra el par sin
 * depender de un diccionario de nombres, que es lo que falla con un archivo que nunca vimos.
 */
/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * UNA COLUMNA DE IDENTIFICADORES NO ES UNA COLUMNA DE DINERO
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *
 * `aNumero` es lenient a propósito: tiene que leer `Q 1,234.50`, `1.234,50` y `-18000`. Lo hace
 * quitando todo lo que no sea dígito o separador, y por eso también "lee" **`FAC-1000` como
 * 1000, `Cliente 3` como 3 y `REC-07` como 7**.
 *
 * El resultado es que casi cualquier columna de texto con un número adentro pasaba por columna
 * de dinero, y este módulo declara duplicadas a dos hojas cuando **alguna** de sus columnas
 * suma parecido a **alguna** de la otra. Con cinco o seis columnas espurias por hoja, la
 * probabilidad de un empate dentro del 1 % por puro azar deja de ser chica — y el precio de ese
 * empate es descartar una hoja entera con todo su dinero.
 *
 * Medido con el generador de libros: `Facturacion` declarada duplicado de `Ventas` y descartada,
 * −Q 63.871 de ingreso, sin una fila marcada y sin nada que fallara.
 *
 * La regla es de FORMA y no de vocabulario: una celda es una cifra si, una vez quitados los
 * símbolos de moneda y los espacios, no queda nada más que dígitos y separadores. `Q 1,234.50`
 * lo cumple; `FAC-1000` no, porque le quedan letras.
 */
const SIMBOLOS_DE_MONEDA = /[qQ$€£]|us\$|usd|gtq|\s|\u00a0/gi;

function pareceCifra(v: unknown): boolean {
  if (typeof v === 'number') return Number.isFinite(v);
  if (typeof v !== 'string') return false;
  // Los paréntesis son la convención contable para un negativo: `(1,200)`.
  const limpio = v.replace(SIMBOLOS_DE_MONEDA, '').replace(/^\((.*)\)$/, '-$1');
  return limpio !== '' && /^-?[\d.,]+$/.test(limpio);
}

function sumasDeColumnasDeDinero(rows: unknown[][]): number[] {
  const datos = rows.slice(1);
  if (datos.length === 0) return [];

  const ancho = Math.max(...rows.map((f) => f.length));
  const sumas: number[] = [];

  for (let c = 0; c < ancho; c++) {
    let suma = 0;
    let cuantos = 0;
    let fechas = 0;
    for (const f of datos) {
      const bruto = f[c];
      // Ver `pareceCifra`: `FAC-1000` no es mil quetzales, es un número de documento.
      if (!pareceCifra(bruto)) continue;
      const n = aNumero(bruto);
      if (n === null) continue;
      suma += n;
      cuantos++;
      /*
       * ═══════════════════════════════════════════════════════════════════════════════════════
       * UNA FECHA CUENTA COMO FECHA AUNQUE VENGA COMO TEXTO (2026-08-31)
       * ═══════════════════════════════════════════════════════════════════════════════════════
       *
       * `ES_SERIAL_DE_FECHA` cubría el caso NUMÉRICO y el encabezado de este módulo ya explica
       * por qué hace falta: un serial vale ~45.000, así que sesenta fechas suman más que la
       * columna de dinero de su propia hoja. Lo que faltaba es que **medio archivo real no trae
       * la fecha como serial**: la trae como `15/07/2026`, que es lo que sale de cualquier libro
       * que pasó por un CSV.
       *
       * Y `aNumero` es lenient a propósito —tiene que leer `Q 1,234.50`—, así que le quita los
       * separadores a `01/04/2026` y devuelve **1042026**. Un número de siete cifras, muy por
       * encima del rango de un serial, que la guarda anterior no podía ver. Dos hojas del mismo
       * período suman entonces ~14 millones cada una y quedan **dentro del 1 %**: el dedup
       * declara duplicada a una de las dos y **se lleva su dinero entero**.
       *
       * Medido con el generador de libros: `Facturacion` descartada como duplicado de `Ventas`,
       * −Q 63.871 de ingreso, sin una sola fila marcada y sin nada que fallara. Es el bug de
       * U3TECH (cero ingresos con la facturación bien leída) por otra puerta.
       *
       * Se juzga sobre el valor CRUDO con `asDate` —el mismo lector del pipeline— y no sobre el
       * número ya mutilado: la pregunta es si esa celda es una fecha, no si el número que salió
       * de ella parece una. Es la misma corrección que necesitó `sheet-relations.comoClave` el
       * mismo día; la ceguera era compartida.
       */
      if (ES_SERIAL_DE_FECHA(n) || asDate(bruto) !== null) fechas++;
    }
    // Una columna con dos números sueltos entre texto no es una columna de dinero.
    if (cuantos < datos.length * 0.6) continue;
    // Si casi todos sus valores caen en el rango de una fecha, es una fecha.
    if (fechas > cuantos * 0.8) continue;
    if (suma > 0) sumas.push(suma);
  }
  return sumas;
}

/**
 * ¿Hay una columna que es una FECHA por fila?
 *
 * Se juzga por el CONTENIDO y no por el nombre, igual que `noPuedeProducirMovimientos`: una
 * hoja cuya columna se llame "Emisión" o "Corte" no tiene ninguna palabra que un vocabulario
 * reconozca, pero sus celdas siguen trayendo fechas.
 */
function tieneColumnaDeFecha(rows: unknown[][]): boolean {
  const datos = rows.slice(1);
  if (datos.length === 0) return false;
  const ancho = Math.max(...rows.map((f) => f.length));

  for (let c = 0; c < ancho; c++) {
    let cuantos = 0;
    let fechas = 0;
    for (const f of datos) {
      const v = f[c];
      if (v === null || v === undefined || v === '') continue;
      cuantos++;
      /*
       * ═══════════════════════════════════════════════════════════════════════════════════
       * SE PREGUNTA CON `asDate`, EL MISMO LECTOR QUE USA EL PIPELINE (2026-08-30)
       * ═══════════════════════════════════════════════════════════════════════════════════
       *
       * La primera versión miraba solo `Date` y seriales numéricos, y se perdía las fechas
       * escritas como TEXTO (`2026-01-12`) — que es como las trae cualquier archivo que pasó
       * por un CSV, y como las escribe medio mundo.
       *
       * El efecto es el fallo de KapePrueba con otra piel: una hoja de ventas con fechas de
       * texto NO cuenta como autosuficiente, así que empata en "ninguna se basta sola" contra
       * un resumen y el desempate cae de vuelta al PROXY del tamaño — el criterio que este
       * módulo dejó de usar justamente porque vaciaba libros enteros.
       *
       * Medido sobre un libro con `Ventas` (48 filas, con Cliente y fecha ISO) y una matriz de
       * ingresos por categoría despivotada (24 filas, sin contraparte): se descartaban las 48
       * ventas de detalle para conservar el agregado sintético.
       */
      if (asDate(v) !== null) fechas++;
    }
    // 0,8 y no 1,0: un archivo real trae una fila a medio llenar en la columna de fecha.
    if (cuantos > 0 && fechas >= cuantos * 0.8) return true;
  }
  return false;
}

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * ¿LAS FILAS DE ESTA HOJA SE BASTAN SOLAS? — LA PREGUNTA QUE DECIDE CUÁL SE CONSERVA
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *
 * El criterio original era "más filas = el detalle", y la razón nº1 escrita arriba para
 * conservar la cabecera es que "sus filas se bastan solas: traen contraparte y fecha, que es
 * lo que el detalle no tiene". O sea: la justificación siempre fue la AUTOSUFICIENCIA, y el
 * conteo de filas era un proxy de ella. **Nadie verificaba la premisa**, y el día que el proxy
 * apuntó al revés se llevó la contabilidad completa de un cliente.
 *
 * ═══ LO QUE COSTÓ (2026-08-28, archivo de demo de KapePrueba) ═══
 *
 * El libro trae, además del detalle, su propio CONSOLIDADO:
 *
 *     Ventas           481 filas · Fecha · Cliente · Venta neta       = 239.588,62
 *     Compras           43 filas · Fecha · Proveedor · Subtotal neto  =  62.836,71
 *     Resumen_Mensual    11 filas · Mes   · (nadie)  · Venta neta total = 239.588,62  ← lo mismo
 *
 * `Resumen_Mensual` dice de sí mismo "Consolidado automático desde la hoja Ventas", así que
 * empatar no es casualidad: **es su naturaleza**. Con "menos filas = cabecera", las 481 ventas
 * y las 43 compras se descartaron y se conservó el resumen de 11 filas. Y un resumen mensual
 * empata contra TODAS las hojas de detalle del libro, así que UNA hoja así lo vacía entero.
 *
 * Es exactamente el error inverso al que el módulo vino a evitar: en vez de contar el dinero
 * dos veces, no lo contó ninguna.
 *
 * ═══ POR QUÉ LA CONTRAPARTE Y NO OTRA SEÑAL ═══
 *
 * Una cabecera y su detalle son el mismo dinero a dos granularidades de LOS MISMOS
 * DOCUMENTOS; un resumen es un AGREGADO POR PERÍODO. Lo que los separa no es el tamaño —el
 * resumen es más chico que la cabecera y la cabecera más chica que el detalle, así que el
 * conteo no puede distinguirlos— sino que **un agregado no tiene contraparte**: no se le vende
 * a "enero". `Resumen_Mensual` tiene fecha (su columna `Mes` son seriales de Excel de verdad),
 * y por eso la fecha sola tampoco alcanza; la contraparte sí.
 *
 * Medido sobre los dos archivos que gobiernan este módulo, el veredicto NO cambia donde ya era
 * correcto — cambia el motivo, que pasa de un proxy a la premisa:
 *
 *     OrdenesCompra   Proveedor ✓  Fecha ✓  → se basta sola → SE CONSERVA (como antes)
 *     LineasOC        —            Fecha ✓  → no            → se descarta (como antes)
 *     Ventas          Cliente   ✓  Fecha ✓  → se basta sola → SE CONSERVA (antes: descartada)
 *     Resumen_Mensual —            Mes   ✓  → no            → se descarta (antes: conservada)
 */
function seBastaSola(rows: unknown[][]): boolean {
  return pareceLibroDeMovimientos(rows[0] ?? []) && tieneColumnaDeFecha(rows);
}

/**
 * Encabezados que las dos hojas comparten, SIN contar los genéricos.
 *
 * ═══ POR QUÉ SE EXCLUYEN LOS GENÉRICOS (2026-08-30) ═══
 *
 * La condición "comparten al menos un encabezado" existe para no relacionar dos hojas que
 * suman parecido por casualidad. Pero `fecha`, `monto` y `moneda` los tiene CUALQUIER hoja de
 * movimientos, así que compartirlos no dice nada: con esos tres, la condición se cumple entre
 * dos hojas cualesquiera del libro y lo único que queda decidiendo es la suma.
 *
 * Medido: en un libro con `Ventas` (una venta de Q 1.500) y `Gastos` (un alquiler de Q 1.500)
 * —tres hojas de una fila cada una— los gastos se descartaron como "duplicado" de las ventas.
 * Una venta y un alquiler no son la misma plata; comparten la forma, no el hecho.
 *
 * Lo que sí es evidencia de relación es un encabezado ESPECÍFICO del libro: un `IDOC`, un
 * `Documento`, un `ID Venta`. Esos son la llave por la que una cabecera y su detalle se unen,
 * y son lo que este detector vino a reconocer.
 */
const ENCABEZADOS_GENERICOS = new Set([
  'fecha', 'fechaemision', 'fechavencimiento', 'fechapago', 'fechamovimiento', 'date',
  'monto', 'importe', 'total', 'valor', 'moneda', 'currency', 'mes', 'periodo',
  'descripcion', 'concepto', 'detalle', 'observaciones', 'nota', 'notas', 'estado',
  'cantidad', 'categoria', 'tipo', 'id', 'no', 'num', 'numero',
]); // prettier-ignore

function encabezadosCompartidos(a: unknown[][], b: unknown[][]): number {
  const ea = new Set(
    (a[0] ?? []).map(normalizar).filter((x) => x !== '' && !ENCABEZADOS_GENERICOS.has(x)),
  );
  const eb = new Set(
    (b[0] ?? []).map(normalizar).filter((x) => x !== '' && !ENCABEZADOS_GENERICOS.has(x)),
  );
  let n = 0;
  for (const x of ea) if (eb.has(x)) n++;
  return n;
}

/**
 * Con muy pocas filas, dos totales iguales son una CASUALIDAD, no evidencia.
 *
 * Este detector afirma algo fuerte —"estas dos hojas son el mismo dinero"— y su costo de
 * equivocarse es tirar la contabilidad de una hoja entera. Esa afirmación necesita masa: dos
 * hojas de tres filas que suman lo mismo se explican por azar tan bien como por duplicación.
 *
 * Los casos que este módulo existe para atrapar son grandes por naturaleza: una cabecera con
 * su detalle (60 y 220 filas), un consolidado contra su origen (11 y 481). Ninguno se acerca
 * a este piso, así que exigirlo no le quita nada y le saca el falso positivo caro.
 */
const MIN_FILAS_PARA_AFIRMAR = 8;

/**
 * Nombres de las hojas de DETALLE que no deben procesarse, porque su dinero ya está contado
 * en otra hoja del mismo libro.
 *
 * El criterio para afirmar que son el mismo dinero es exigente a propósito: los totales tienen
 * que coincidir dentro del 1 % Y las hojas tienen que compartir al menos un encabezado (la
 * llave que las une). Solo con los totales, dos hojas distintas que casualmente sumen parecido
 * —dos meses de venta, por ejemplo— se descartarían entre sí, y ahí sí se perdería
 * contabilidad de verdad.
 */
export function detectarDetalleDuplicado(hojas: HojaParaComparar[]): Map<string, string> {
  const aOmitir = new Map<string, string>();
  const conSumas = hojas.map((h) => ({
    ...h,
    sumas: sumasDeColumnasDeDinero(h.rows),
    seBasta: seBastaSola(h.rows),
  }));

  for (let i = 0; i < conSumas.length; i++) {
    for (let j = i + 1; j < conSumas.length; j++) {
      const a = conSumas[i]!;
      const b = conSumas[j]!;

      // Ver `MIN_FILAS_PARA_AFIRMAR`: con pocas filas, dos totales iguales son casualidad.
      if (a.rows.length - 1 < MIN_FILAS_PARA_AFIRMAR) continue;
      if (b.rows.length - 1 < MIN_FILAS_PARA_AFIRMAR) continue;

      const coinciden = a.sumas.some((sa) =>
        b.sumas.some((sb) => Math.abs(sa - sb) / Math.max(sa, sb) <= 0.01),
      );
      if (!coinciden) continue;
      /*
       * Entre dos hojas DESPIVOTADAS el encabezado no dice nada (ver `conceptos`): se compara
       * lo único que las distingue, que son los rubros que nombran.
       */
      if (a.conceptos && b.conceptos) {
        const comunes = [...a.conceptos].filter((c) => b.conceptos!.has(c)).length;
        const menor = Math.min(a.conceptos.size, b.conceptos.size);
        if (menor === 0 || comunes / menor < 0.5) continue;
      } else if (encabezadosCompartidos(a.rows, b.rows) === 0) {
        continue;
      }

      /*
       * SE CONSERVA LA QUE SE BASTA SOLA. Ver el bloque de `seBastaSola`: la autosuficiencia
       * (contraparte + fecha por fila) siempre fue la razón para conservar la cabecera, y el
       * conteo de filas era solo un proxy de ella. Cuando exactamente una de las dos la
       * cumple, se decide por la premisa y no por el proxy.
       */
      let cabecera: typeof a;
      let detalle: typeof a;
      if (a.seBasta !== b.seBasta) {
        cabecera = a.seBasta ? a : b;
        detalle = a.seBasta ? b : a;
      } else {
        // Ninguna o las dos: no hay nada que las distinga salvo el tamaño, y ahí el proxy
        // sigue siendo lo mejor que se tiene. Más filas = el detalle.
        detalle = a.rows.length >= b.rows.length ? a : b;
        cabecera = detalle === a ? b : a;
        if (detalle.rows.length === cabecera.rows.length) {
          /*
           * ═══ EL MISMO NÚMERO DE FILAS Y EL MISMO DINERO AL CENTAVO: ES UNA COPIA ═══
           *
           * La regla de arriba —sin cabecera clara, no se toca— existe para no elegir al azar
           * entre dos hojas distintas. Pero hay un caso donde no hay nada que elegir: dos
           * hojas con **el mismo número de filas y un total idéntico al centavo**, que además
           * comparten encabezados. Eso no es coincidencia, es la misma tabla dos veces —una
           * copia de respaldo, una hoja duplicada al exportar, `Ventas` y `Ventas (2)`.
           *
           * Medido: con la regla anterior las dos se procesaban y la facturación del cliente
           * salía al DOBLE. Ninguna de las dos gana por autosuficiencia (las dos la tienen) ni
           * por tamaño (son iguales), así que el caso caía en el `continue` y no se descartaba
           * nada.
           *
           * El umbral acá es al CENTAVO y no el 1 % que usa el resto del módulo: dos conjuntos
           * de datos distintos no suman exactamente lo mismo hasta el último decimal, y esa
           * exactitud es justamente lo que distingue una copia de dos meses parecidos.
           */
          const identico = a.sumas.some((sa) => b.sumas.some((sb) => Math.abs(sa - sb) < 0.005));
          if (!identico) continue;
          // Da igual cuál se descarte: son la misma tabla. Se conserva la primera del libro.
          detalle = b;
          cabecera = a;
        }
      }

      /*
       * ═══ LA CONSERVADA TIENE QUE SOBREVIVIR, O NO SE DESCARTA NADA ═══
       *
       * Descartar una hoja "porque su dinero ya está contado en otra" solo es cierto si esa
       * otra de verdad se procesa. En el archivo de KapePrueba no se procesaba: el dedup
       * conservaba `Resumen_Mensual` y el filtro SIGUIENTE
       * (`noPuedeProducirMovimientos`) la descartaba por su cuenta. Las dos decisiones eran
       * defendibles por separado y juntas dejaron el dashboard del cliente en cero.
       *
       * Ningún reordenamiento de filtros arregla esto en general —siempre hay un filtro
       * después—, así que la condición se afirma acá: si la conservada no va a producir
       * movimientos, el par se deja intacto. El peor caso pasa a ser contar de más, que se
       * ve; el que se elimina es contar CERO, que no se ve.
       */
      if (cabecera.puedeProducirMovimientos === false) continue;

      /*
       * El texto dice "el mismo dinero" y no "tus compras": mientras el módulo solo conocía el
       * par cabecera/detalle de una orden de compra, "compras" era exacto. Con el resumen
       * mensual de ventas de KapePrueba pasó a ser falso — el cliente leía que no se
       * duplicaron sus compras a propósito de su hoja de ventas.
       *
       * `has` y no sobrescribir: un resumen empata contra VARIAS hojas de detalle, y sin esto
       * el mensaje nombraba a la última con la que empató en vez de a la primera.
       */
      if (!aOmitir.has(detalle.nombre)) {
        aOmitir.set(
          detalle.nombre,
          `sus montos ya están contados en la hoja "${cabecera.nombre}" (las dos suman lo ` +
            'mismo): se usó esa para no contar el mismo dinero dos veces',
        );
      }
    }
  }
  return aOmitir;
}
