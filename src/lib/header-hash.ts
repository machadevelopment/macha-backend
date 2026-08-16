import { createHash } from 'node:crypto';
import { normalizeHeader } from './sheet-classifier';

/**
 * Huella de la ESTRUCTURA de una hoja: qué columnas trae y en qué orden.
 *
 * ═══ PARA QUÉ (CU-868krmrcj, ARCHITECTURE 6.3.12) ═══
 *
 * Es la llave del perfil de mapeo por empresa. Dos cargas del mismo layout dan el mismo
 * hash, así que el mapa de columnas se resuelve UNA vez y las cargas siguientes lo
 * reutilizan en vez de volver a inferirlo.
 *
 * ═══ SE NORMALIZA CON LA MISMA FUNCIÓN QUE EL PRE-FILTRO, A PROPÓSITO ═══
 *
 * `normalizeHeader` vive en `sheet-classifier.ts` y se importa en vez de copiarse. La
 * tentación de duplicarla es real —son cuatro líneas— y sería un error: esa función ya
 * arrastra una corrección medida contra archivos reales (quitar los paréntesis ANTES de
 * borrar la puntuación, porque "Precio Unitario (Q)" normalizaba a `preciounitarioq` y no
 * casaba con nada). Dos copias divergen, y el día que divergen el perfil de una empresa deja
 * de encontrarse sin que nada falle: se re-infiere el mapa en cada carga y el ahorro
 * desaparece en silencio.
 *
 * Que la normalización sea agresiva es lo correcto ACÁ: "Precio Unitario (Q)",
 * "precio_unitario" y "PRECIO UNITARIO" son la misma columna exportada por tres caminos, y
 * el perfil tiene que reconocerlas como el mismo layout. Un cliente que reexporta desde otro
 * sistema no debería quedarse sin perfil por un guion bajo.
 *
 * ═══ QUÉ SÍ CAMBIA EL HASH, Y POR QUÉ ESTÁ BIEN ═══
 *
 * · El ORDEN. Las mismas columnas movidas de sitio son un layout distinto, y tienen que
 *   serlo: el mapa guarda ÍNDICES de columna. Reutilizar un mapa sobre columnas reordenadas
 *   leería el monto de la columna de fechas — el peor fallo posible, porque es plausible.
 * · Las columnas VACÍAS intermedias. Se conservan como cadena vacía en vez de filtrarse, por
 *   lo mismo: una columna en blanco en la posición 3 corre todos los índices siguientes.
 *
 * El nombre de la hoja NO entra. La misma tabla exportada como "Ventas" o como "Ventas 2026"
 * sigue siendo el mismo layout, y meterlo en la llave daría un perfil nuevo cada año.
 */

/**
 * Separador imposible de producir. `normalizeHeader` devuelve solo `[a-z0-9]`, así que la
 * barra vertical no puede aparecer dentro de un encabezado normalizado y no hay forma de que
 * dos filas distintas se concatenen a la misma cadena.
 */
const SEPARADOR = '|';

/** `sha256` en hex (64 caracteres), igual que `row-fingerprint.ts`. */
export function hashDeEncabezados(headerRow: readonly unknown[]): string {
  const material = headerRow.map((celda) => normalizeHeader(celda)).join(SEPARADOR);
  return createHash('sha256').update(material).digest('hex');
}

/**
 * Los encabezados normalizados, para GUARDARLOS junto al perfil.
 *
 * El hash contesta "¿es el mismo layout?" pero no se puede leer. Cuando un operador tenga que
 * entender por qué el perfil de una empresa no está calzando, la lista es lo único que
 * permite comparar el archivo nuevo contra el que originó el perfil. Un hash suelto convierte
 * ese diagnóstico en adivinanza.
 */
export function encabezadosNormalizados(headerRow: readonly unknown[]): string[] {
  return headerRow.map((celda) => normalizeHeader(celda));
}
