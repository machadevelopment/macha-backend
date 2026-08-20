import { env } from './env';

/**
 * El isotipo de Macha —las tres barras salvia— en base64.
 *
 * ═══ POR QUÉ VIVE EN EL CÓDIGO ═══
 *
 * Lo consume el PDF del reporte (CU-868ku6pax), que se abre FUERA de la app y a veces sin
 * red: ahí el binario tiene que viajar dentro del archivo o el logo no existe.
 *
 * ═══ EL CORREO YA NO LO USA, Y ESA FUE UNA CORRECCIÓN ═══
 *
 * La primera versión de este archivo decía que un correo "no puede depender de una URL
 * nuestra porque Gmail y Outlook bloquean las imágenes remotas por defecto". Las dos mitades
 * estaban al revés, y el resultado fue el logo roto que reportó Jose:
 *
 *   · Gmail SÍ carga imágenes remotas, desde 2013, por su propio proxy
 *     (`googleusercontent.com`) y sin preguntarle a quien lee.
 *   · Gmail NO renderiza `data:` URIs en el cuerpo de un correo: los descarta.
 *
 * O sea que se había elegido el único formato que Gmail no soporta, para esquivar un bloqueo
 * que Gmail dejó de hacer hace más de una década. El correo ahora usa `ISOTIPO_URL`.
 *
 * Sale del HTML que aprobó Jose (adjunto de CU-868ku64e3, `macha_email_invitacion.html`),
 * donde ya venía embebido de esta forma: 170x200 px, PNG con alfa. No se re-exportó de otra
 * fuente a propósito — el que se aprobó es este.
 *
 * ═══ UNA SOLA COPIA PARA CORREOS Y PDF ═══
 *
 * `report-render.ts` necesita el mismo logo para la cabecera del PDF (CU-868ku6pax) y lo
 * consume desde acá. Dos copias del mismo binario en el repo se desincronizan el día que la
 * marca cambie de isotipo, y el que quede viejo no falla: solo se ve mal.
 *
 * `src/assets/isotipo.png` es el MISMO archivo en binario, para quien necesite verlo o
 * re-generar esta constante (`base64 -w0 src/assets/isotipo.png`). El código lee esta
 * constante y no el archivo: `bun build` produce un bundle y un `readFile` relativo se rompe
 * según desde dónde se levante el proceso.
 */
export const ISOTIPO_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAKoAAADICAYAAAB4SnrTAAAL9klEQVR4nO2dTW4kuRGFHynqx1ChF+OBbXjnra/gnU/gQ/gO' +
  '3vY1fABfwAeYpeETeDvrAWwYaA8wo8yqpBdZqWSW+keqoLr4KfgaAhqNUc7LelFBRjAiGH788cM/U7r+3TgOUwgKAiClpGH4' +
  '6Y/v3n37r5xzDCFMz/m9nHMIIeS//f2v346H8I9wFd/l/SFLzb93vkpX8TBNP+z13z/8+U9/+d/yLs/65eNn9OHDv39/c/OL' +
  '7/b7/WvzrYKcla+vb+J+P36fcs6/ubm5/lXOk0JoXa8ZKV1pv4/X5/7+YTzEHK9+e311dX/Iufn3zjkrpaT9w0O8vb07m2yM' +
  '8Tql9Ov2v5czcs66ubnWOA4/pRDCOI5j3u/3BM8iScp5Us56ljf5FGIO42F/yNMhZym3/t75EA4hKIymh2TlWetDLV6vjRxj' +
  'DCGEMUkK4ehSQuuu5YgqNEPAvHeevX4IUpC+MT2reO3msby3pJByzlp+KMg5azT5Fs1rR/nTOipwHEcpJY7WpW2mS5M5B3U+' +
  'Z6Kl2nlCbPQJkIZaAzwzhaRkXglpDkw4y4GkOlx5llqFJ0nrdemfvHrUnYLGo5di+CoKz9dCypLy8Q8FJK6tgaR1LtgmzZYq' +
  'CPcZNbg6XfpRWhe2maaN3TJQg2s4+dM6Qq2oH6T1wnVSVrw0mY6O5yBpynNyDRIJSjpyHc7//Z2kISiE9ad1LDxtKg1SvuNo' +
  'vdjldEz4k7YtEotrayBpXXJNmx0rBl6jqRo7NZLWq23O6Sniym9ECNuf1rHwtL46SeuF65yecutRvYKkdelRobGUIZTSvaSH' +
  'AAymoo3nIOkOpHVpmz091YFAWtP9kK+Zah2hEoMpnwn/rKykPPlb+8UNpkzArv1uq6ckrx6ViuQ15vdqpiStS9tMoob9sjZN' +
  'ecQo5SuO1oVtuvWoEZieikHmlydpvfWom3+igMS1NZC0XrkmbPGUEUHCedQQgvnlSVoXxVP9CNUfSFqfFqWIQ12audpDKWrc' +
  'f75So6Qr0xO+Lt5I1G8HwTyrg6R1GfVLTI9qw71CeGDuUY0gab0tnJ7EYi+xuLYGktYL18lxMEXdof7S/CSS1ptgymn1FLEq' +
  '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' +
  'CPwfEHo98oxk95oAAAAASUVORK5CYII=';

/**
 * Listo para pegar en un `src` de `<img>`. **Solo para HTML que se ve en un navegador.**
 *
 * Un cliente de correo lo descarta (ver la nota de arriba). Se conserva porque el HTML del
 * reporte —el que se sirve autenticado en la app, no el PDF— sí lo puede usar.
 */
export const ISOTIPO_DATA_URI = `data:image/png;base64,${ISOTIPO_PNG_BASE64}`;

/**
 * El isotipo servido públicamente, para los CORREOS.
 *
 * Sale de `env.appBaseUrl` y no de una variable propia: es el mismo dominio público del
 * frontend que ya usan todos los enlaces de los correos (`app-urls.ts`). Una segunda variable
 * para la misma URL es una que se puede quedar desincronizada, y el síntoma sería un logo roto
 * en producción y un correo que sí funciona en local.
 *
 * ⚠️ La ruta es parte del contrato de todo correo YA ENVIADO: uno de hace seis meses sigue
 * pidiendo este archivo. Moverlo o renombrarlo rompe el logo del historial completo, no solo
 * de los correos nuevos. El archivo vive en `macha-frontend/public/brand/isotipo.png` y ese
 * directorio está excluido del matcher del middleware a propósito — dentro, `authkitProxy`
 * responde 307 hacia WorkOS y un cliente de correo no sigue redirecciones para cargar una
 * imagen.
 */
export const ISOTIPO_URL = `${env.appBaseUrl}/brand/isotipo.png`;

/** Los bytes del PNG, para `pdf-lib` (`embedPng`) y cualquier consumidor binario. */
export function isotipoPngBytes(): Uint8Array {
  return Uint8Array.from(atob(ISOTIPO_PNG_BASE64), (c) => c.charCodeAt(0));
}

/** Proporción nativa del PNG (170x200), para escalarlo sin deformarlo. */
export const ISOTIPO_ASPECTO = 170 / 200;
