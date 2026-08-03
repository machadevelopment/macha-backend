import { unzipSync, strFromU8 } from 'fflate';

/**
 * CU-868kjc6h1 criterio 2: detectar ANTES de procesar que un archivo trae una moneda
 * que la empresa no puede convertir. Sin esto, el upload se sube a S3, se encola, gasta
 * una llamada a Claude por hoja y recién muere en la promoción — pagando el costo de IA
 * completo para no ingresar ni una fila.
 *
 * ES UNA HEURÍSTICA, Y ESO ESTÁ ASUMIDO. Busca el código ISO ('USD'/'GTQ') como palabra
 * en el texto del archivo, que es exactamente la señal de la que depende el propio
 * clasificador para poblar `original_currency`. No mira símbolos ('$' es ambiguo entre
 * ambas monedas) ni formatos numéricos de celda.
 *
 * Por eso el resultado solo se usa para RECHAZAR cuando la empresa no tiene ninguna tasa
 * del par: en ese escenario cualquier fila en esa moneda tumbaría la carga entera de
 * todos modos, así que un falso positivo cuesta un rechazo con un mensaje accionable, no
 * datos perdidos. El caso contrario —moneda extranjera que la heurística no ve— no queda
 * sin red: la fila se marca para revisión al clasificarla (lib/staging.ts) en vez de
 * hacer fallar el documento.
 */

/** Formatos que se pueden inspeccionar barato. `.xls` (binario OLE2) no. */
export type ScannableExt = 'xlsx' | 'csv';

export function isScannable(ext: string): ext is ScannableExt {
  return ext === 'xlsx' || ext === 'csv';
}

function mentionsCode(text: string, code: string): boolean {
  // Límite de palabra a ambos lados: "USD" sí, "USDT" o "AUSD" no.
  return new RegExp(`(^|[^A-Za-z])${code}([^A-Za-z]|$)`).test(text);
}

/**
 * ¿El archivo menciona el código de moneda? Para `.xlsx` mira las cadenas compartidas
 * (donde viven los textos de celda de un libro normal) y el XML de las hojas (cadenas
 * en línea y fórmulas). Para `.csv`, el texto tal cual.
 *
 * Nunca lanza: un archivo corrupto o un zip que no se puede abrir no es asunto de esta
 * función — el parseo real ocurre en el worker y ahí sí se reporta. Ante la duda
 * devuelve `false` (no bloquear por no poder mirar).
 */
export function fileMentionsCurrency(buffer: Uint8Array, ext: ScannableExt, code: string): boolean {
  try {
    if (ext === 'csv') {
      return mentionsCode(strFromU8(buffer), code);
    }

    const zip = unzipSync(buffer, {
      filter: (file) =>
        file.name === 'xl/sharedStrings.xml' || /^xl\/worksheets\/sheet\d+\.xml$/.test(file.name),
    });

    return Object.values(zip).some((part) => mentionsCode(strFromU8(part), code));
  } catch {
    return false;
  }
}
