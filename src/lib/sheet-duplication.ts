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
  const conSumas = hojas.map((h) => ({ ...h, sumas: sumasDeColumnasDeDinero(h.rows) }));

  for (let i = 0; i < conSumas.length; i++) {
    for (let j = i + 1; j < conSumas.length; j++) {
      const a = conSumas[i]!;
      const b = conSumas[j]!;

      const coinciden = a.sumas.some((sa) =>
        b.sumas.some((sb) => Math.abs(sa - sb) / Math.max(sa, sb) <= 0.01),
      );
      if (!coinciden) continue;
      if (encabezadosCompartidos(a.rows, b.rows) === 0) continue;

      // Más filas = el detalle. Se conserva la cabecera, que trae contraparte y fecha.
      const detalle = a.rows.length >= b.rows.length ? a : b;
      const cabecera = detalle === a ? b : a;
      if (detalle.rows.length === cabecera.rows.length) continue; // sin cabecera clara, no se toca

      aOmitir.set(
        detalle.nombre,
        `sus montos ya están contados en la hoja "${cabecera.nombre}" (las dos suman lo mismo): ` +
          'se usó esa para no duplicar tus compras',
      );
    }
  }
  return aOmitir;
}
