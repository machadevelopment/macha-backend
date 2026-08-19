import { ISOTIPO_DATA_URI } from '@/lib/brand-asset';

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════
 * EL SHELL DE CORREO DE MARCA — CU-868ku6jn1
 * ═══════════════════════════════════════════════════════════════════════════════════════
 *
 * Los tres correos que manda la app (reporte listo, alerta disparada, invitación) salían en
 * HTML plano: `<p><strong>alguien</strong> te invitó...</p>`. Jose lo reportó con una captura
 * de un correo real: sin logo, sin tipografía, sin nada — indistinguible de spam en un
 * producto financiero, donde el correo tiene que parecer legítimo antes de que alguien
 * apriete su enlace.
 *
 * Este módulo es el maquetado ÚNICO, extraído de la plantilla que Jose aprobó
 * (`macha_email_invitacion.html`, adjunta a CU-868ku64e3). Cada correo aporta su título, su
 * cuerpo y su botón; el resto —la tarjeta de 600px, el logo con su marco, el botón negro de
 * píldora, el enlace de respaldo, el divisor y el pie con el tagline— vive acá y solo acá.
 *
 * ═══ POR QUÉ TABLAS Y ESTILOS EN LÍNEA, QUE PARECE HTML DE 2005 ═══
 *
 * Porque es lo que sobrevive en un cliente de correo. Outlook renderiza con el motor de Word,
 * Gmail borra el `<style>` del `<head>` en varias vistas, y ninguno de los dos garantiza
 * flexbox ni grid. El HTML de la plantilla aprobada ya está escrito así, y reescribirlo con
 * CSS moderno lo rompería justo en los dos clientes donde más se lee. Los estilos van en el
 * atributo `style` de cada celda a propósito.
 *
 * El bloque `<style>` del `<head>` se conserva igual que en la maqueta, pero solo lleva
 * MEJORAS: el `:hover` del botón y el ajuste a pantalla angosta. Si un cliente lo descarta,
 * el correo se sigue viendo bien — nada estructural depende de él.
 */

/**
 * Escapa texto que va a interpolarse en el HTML del correo.
 *
 * ═══ ESTO NO ES DEFENSIVO POR COSTUMBRE: ARREGLA UNA INYECCIÓN QUE YA EXISTÍA ═══
 *
 * Las plantillas anteriores interpolaban `companyName` e `invitedByEmail` CRUDOS
 * (`<strong>${invitedByEmail}</strong>`), y los dos son texto que escribe un usuario: el
 * nombre de empresa se captura en el registro y el correo del invitador sale de su cuenta.
 * Una empresa llamada `<a href="http://otro-sitio">Actualiza tu contraseña</a>` habría
 * llegado como un enlace de verdad, en un correo legítimamente firmado por
 * `notificaciones@macha.finance` y en un producto financiero. Eso es phishing con nuestro
 * remitente, y era gratis.
 *
 * Se escapan los cinco caracteres que importan. `&` va primero, porque si no, re-escaparía
 * las entidades que los otros cuatro acaban de introducir.
 */
export function escaparHtml(texto: string): string {
  return texto
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Escapa una URL para meterla en un `href`.
 *
 * Aparte del escapado de HTML, se rechaza cualquier esquema que no sea `http(s)`. Todas las
 * URL de estos correos las arma el backend (`appBaseUrl` + ruta + token), así que un
 * `javascript:` no debería poder llegar acá — y precisamente por eso el chequeo es barato:
 * si algún día una URL empieza a venir de otro lado, falla del lado seguro en vez de
 * convertirse en el vector.
 */
function urlSegura(url: string): string {
  const limpia = url.trim();
  if (!/^https?:\/\//i.test(limpia)) return '#';
  return escaparHtml(limpia);
}

export interface BrandedEmailParams {
  /** Título grande de la tarjeta. Se escapa: puede traer el nombre de la empresa. */
  title: string;
  /**
   * Cuerpo, en HTML YA ARMADO Y YA ESCAPADO por quien llama.
   *
   * Es el único campo que no se escapa acá, porque los cuerpos necesitan marcado propio (el
   * `<span>` que resalta el nombre de quien invita, por ejemplo). Quien lo construye pasa sus
   * partes variables por `escaparHtml`. Se llama `bodyHtml` y no `body` justamente para que
   * el nombre lo diga en el sitio de la llamada.
   */
  bodyHtml: string;
  /** Texto del botón. */
  ctaLabel: string;
  /** Destino del botón y del enlace de respaldo. */
  ctaUrl: string;
  /**
   * Nota al pie DENTRO de la tarjeta, bajo el divisor (la invitación explica ahí que el
   * enlace vence en 7 días). Opcional: reportes y alertas no la necesitan.
   */
  footnote?: string;
  /**
   * `true` muestra el enlace completo en texto bajo el botón, como hace la maqueta.
   *
   * Solo la invitación lo lleva, y la razón es concreta: quien la recibe puede no tener
   * cuenta todavía y estar leyendo desde un cliente que no deja apretar botones. Para un
   * reporte o una alerta, quien recibe ya es usuario y el enlace crudo —que lleva ids— solo
   * ensucia.
   */
  showPlainLink?: boolean;
  locale: 'es' | 'en';
}

/** Copy del pie, lo único del shell que cambia entre idiomas. */
const PIE = {
  es: {
    tagline: 'Convierte datos, en decisiones.',
    automatico:
      '&copy; 2026 Macha Finance. Este es un correo autom&aacute;tico, por favor no respondas a esta direcci&oacute;n.',
    copiaPega: 'O copia y pega este enlace en tu navegador:',
  },
  en: {
    tagline: 'Turn data into decisions.',
    automatico:
      '&copy; 2026 Macha Finance. This is an automated message, please do not reply to this address.',
    copiaPega: 'Or copy and paste this link into your browser:',
  },
} as const;

/**
 * Arma el correo completo. Devuelve el documento HTML entero, listo para Resend.
 *
 * Los colores van como literales y NO como tokens de diseño, que es lo contrario de la regla
 * del frontend. No hay alternativa: un correo no tiene hoja de estilos ni variables CSS
 * fiables, y estos valores son los del HTML que Jose aprobó (`#F5F6F4` de fondo, `#E9EBE7`
 * de borde, `#0A0A0A` de tinta, `#6B6F6A` y `#9AA09A` de texto secundario). Si la marca
 * cambia, cambian acá, en un solo lugar.
 */
export function renderBrandedEmail(params: BrandedEmailParams): string {
  const t = PIE[params.locale];
  const href = urlSegura(params.ctaUrl);

  const enlacePlano = params.showPlainLink
    ? `
      <tr><td class="px" style="padding:22px 48px 0;font-size:13px;line-height:1.6;color:#9AA09A;">
        ${t.copiaPega}<br>
        <a href="${href}" style="color:#6B6F6A;text-decoration:underline;word-break:break-all;">${href}</a>
      </td></tr>`
    : '';

  const notaAlPie = params.footnote
    ? `
      <tr><td class="px" style="padding:26px 48px 0;"><div style="height:1px;background:#E9EBE7;line-height:1px;font-size:0;">&nbsp;</div></td></tr>
      <tr><td class="px" style="padding:18px 48px 44px;font-size:12.5px;line-height:1.6;color:#9AA09A;">
        ${escaparHtml(params.footnote)}
      </td></tr>`
    : `
      <tr><td class="px" style="padding:0 48px 44px;"></td></tr>`;

  return `<!DOCTYPE html>
<html lang="${params.locale}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Macha Finance</title>
<style>
  body{margin:0;padding:0;background:#F5F6F4;font-family:-apple-system,BlinkMacSystemFont,'SF Pro Display','Segoe UI',Roboto,Helvetica,Arial,sans-serif}
  table{border-collapse:collapse}
  img{border:0;line-height:100%;outline:none;text-decoration:none;display:block}
  a{text-decoration:none}
  .btn:hover{background:#222222!important}
  @media only screen and (max-width:620px){
    .card{width:100%!important;border-radius:0!important}
    .px{padding-left:24px!important;padding-right:24px!important}
  }
</style>
</head>
<body style="margin:0;padding:0;background:#F5F6F4;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F5F6F4;">
  <tr><td align="center" style="padding:40px 16px;">
    <table role="presentation" width="600" cellpadding="0" cellspacing="0" class="card" style="width:600px;max-width:600px;background:#FFFFFF;border:1px solid #E9EBE7;border-radius:20px;overflow:hidden;">
      <tr><td class="px" style="padding:44px 48px 0;">
        <table role="presentation" cellpadding="0" cellspacing="0"><tr>
          <td width="64" height="64" align="center" valign="middle" style="width:64px;height:64px;background:#FFFFFF;border:1px solid #E9EBE7;border-radius:16px;box-shadow:0 2px 8px rgba(20,30,20,.06);">
            <img src="${ISOTIPO_DATA_URI}" alt="Macha Finance" style="display:block;height:36px;width:auto;margin:0 auto;">
          </td>
        </tr></table>
      </td></tr>
      <tr><td class="px" style="padding:26px 48px 0;font-size:26px;line-height:1.25;font-weight:700;color:#0A0A0A;letter-spacing:-.02em;">
        ${escaparHtml(params.title)}
      </td></tr>
      <tr><td class="px" style="padding:14px 48px 0;font-size:15px;line-height:1.6;color:#6B6F6A;">
        ${params.bodyHtml}
      </td></tr>
      <tr><td class="px" style="padding:28px 48px 0;">
        <table role="presentation" cellpadding="0" cellspacing="0"><tr>
          <td align="center" style="border-radius:100px;background:#0A0A0A;">
            <a class="btn" href="${href}" style="display:inline-block;padding:15px 34px;font-size:15px;font-weight:600;color:#ffffff;border-radius:100px;letter-spacing:-.01em;">${escaparHtml(params.ctaLabel)}</a>
          </td>
        </tr></table>
      </td></tr>${enlacePlano}${notaAlPie}
    </table>
    <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:600px;max-width:600px;">
      <tr><td align="center" style="padding:22px 24px 8px;">
        <table role="presentation" cellpadding="0" cellspacing="0"><tr>
          <td style="padding-right:8px;"><img src="${ISOTIPO_DATA_URI}" alt="" style="display:block;height:18px;width:auto;"></td>
          <td style="font-size:13px;font-weight:600;color:#0A0A0A;letter-spacing:-.01em;">Macha Finance</td>
        </tr></table>
      </td></tr>
      <tr><td align="center" style="padding:0 24px 4px;font-size:11px;line-height:1.6;color:#9AA09A;">${t.tagline}</td></tr>
      <tr><td align="center" style="padding:4px 24px 0;font-size:11px;line-height:1.6;color:#9AA09A;">${t.automatico}</td></tr>
    </table>
  </td></tr>
</table>
</body>
</html>`;
}

/** Resalta un dato dentro del cuerpo, como hace la maqueta con el nombre de la empresa. */
export function destacado(texto: string): string {
  return `<span style="color:#0A0A0A;font-weight:600;">${escaparHtml(texto)}</span>`;
}
