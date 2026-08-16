/**
 * El título de una conversación del asesor, derivado de la primera pregunta del usuario.
 *
 * ═══ POR QUÉ NO SE LE PIDE A LA IA (CU-868krkw4p) ═══
 *
 * El ticket dejaba la decisión abierta entre "primer mensaje" y "llamada corta a un modelo".
 * Se toma la primera, y no solo por barata:
 *
 *   · El costo NO sería cero ni al usar un modelo pequeño. Sería una llamada más POR CHAT, y
 *     el chat es la función que más se usa. Y titular el propio chat de uno no es algo por lo
 *     que se le pueda cobrar créditos al cliente — así que ese gasto no tiene de dónde
 *     recuperarse. Esa asimetría es la que decide.
 *   · La primera pregunta de un usuario a un asesor financiero YA es un título: "¿por qué
 *     bajó mi margen en julio?" describe la conversación mejor que cualquier resumen. El caso
 *     donde la IA gana —una conversación que deriva a otro tema— se resuelve dejando renombrar
 *     a mano, no pagando por adivinar.
 *   · Es instantáneo y no puede fallar. Un título por IA agrega una llamada de red al camino
 *     del primer mensaje, que es justo el momento en que la pantalla tiene que responder.
 *
 * Si más adelante la calidad no alcanza, el reemplazo es local: esta función y su llamador.
 */

/**
 * Los textos con que nace un chat sin usar. Un chat solo se auto-titula si todavía lleva uno
 * de estos.
 *
 * ES UNA LISTA Y NO UNA CONSTANTE porque el marcador se escribe en el idioma de la empresa
 * (`POST /chats`), y porque los chats que ya existen en producción se crearon todos con
 * 'Nuevo chat' — incluidos los de empresas en inglés, que es su propio defecto y esta lista
 * también cubre.
 *
 * Un título puesto a mano por el usuario NO está acá, y por eso no se pisa.
 */
export const TITULOS_POR_DEFECTO = ['Nuevo chat', 'New chat'] as const;

export function esTituloPorDefecto(titulo: string): boolean {
  const limpio = titulo.trim().toLowerCase();
  return TITULOS_POR_DEFECTO.some((t) => t.toLowerCase() === limpio);
}

export function tituloPorDefecto(locale: string): string {
  return locale === 'en' ? 'New chat' : 'Nuevo chat';
}

/**
 * Largo máximo del título. La lista de chats del sidebar trunca visualmente de todas formas,
 * pero guardar el mensaje entero convertiría la columna en un duplicado del primer mensaje —
 * y un `title` de varios párrafos es una sorpresa esperando en cualquier consumidor futuro
 * (un `<title>`, un asunto de correo, un export).
 */
const LARGO_MAXIMO = 60;

/**
 * Título a partir del primer mensaje del usuario, o `null` si de ahí no sale nada usable.
 *
 * `null` importa: significa "dejá el marcador como está". Un mensaje que es solo un emoji, o
 * solo espacios, produciría un título peor que "Nuevo chat" — y una cadena vacía en la lista
 * dejaría una fila que no se puede ni clicar con confianza.
 */
export function tituloDesdePrimerMensaje(mensaje: string): string | null {
  // Los saltos de línea y los espacios repetidos se colapsan ANTES de medir: un mensaje
  // pegado desde otro lado trae saltos, y cortar a 60 caracteres contando saltos dejaría un
  // título mucho más corto de lo que parece — o con un salto dentro, que en la lista se
  // renderiza como un espacio y descuadra la fila.
  const limpio = mensaje.replace(/\s+/g, ' ').trim();
  if (!limpio) return null;

  if (limpio.length <= LARGO_MAXIMO) return limpio;

  /*
   * Se corta en el ÚLTIMO espacio antes del límite, no a la brava. "¿Cuánto gasté en
   * proveedo…" se lee peor que "¿Cuánto gasté en…", y en español las palabras son largas: un
   * corte ciego parte una de cada dos veces.
   *
   * Si en los últimos 20 caracteres del límite no hay ningún espacio, se corta duro: es una
   * sola palabra larguísima (una URL, un id) y respetar la palabra dejaría el título vacío o
   * casi.
   */
  const recorte = limpio.slice(0, LARGO_MAXIMO);
  const ultimoEspacio = recorte.lastIndexOf(' ');
  const base = ultimoEspacio > LARGO_MAXIMO - 20 ? recorte.slice(0, ultimoEspacio) : recorte;

  // Sin signos de puntuación colgando antes de los puntos suspensivos ("julio,…").
  return `${base.replace(/[\s,;:.\-–—]+$/, '')}…`;
}
