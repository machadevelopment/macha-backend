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
      const n = aNumero(f[c]);
      if (n === null) continue;
      suma += n;
      cuantos++;
      if (ES_SERIAL_DE_FECHA(n)) fechas++;
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

/** Encabezados que las dos hojas comparten: la llave por la que se relacionan. */
function encabezadosCompartidos(a: unknown[][], b: unknown[][]): number {
  const ea = new Set((a[0] ?? []).map(normalizar).filter((x) => x !== ''));
  const eb = new Set((b[0] ?? []).map(normalizar).filter((x) => x !== ''));
  let n = 0;
  for (const x of ea) if (eb.has(x)) n++;
  return n;
}

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

      const coinciden = a.sumas.some((sa) =>
        b.sumas.some((sb) => Math.abs(sa - sb) / Math.max(sa, sb) <= 0.01),
      );
      if (!coinciden) continue;
      if (encabezadosCompartidos(a.rows, b.rows) === 0) continue;

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
        if (detalle.rows.length === cabecera.rows.length) continue; // sin cabecera clara, no se toca
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
