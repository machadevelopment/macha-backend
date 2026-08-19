import { describe, expect, test } from 'bun:test';
import { renderBrandedEmail, escaparHtml, destacado } from './email-shell';
import { ISOTIPO_DATA_URI, ISOTIPO_ASPECTO, isotipoPngBytes } from './brand-asset';
import { TEMPLATES } from './email';

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════
 * EL SHELL DE CORREO — CU-868ku6jn1 · CU-868ku64e3
 * ═══════════════════════════════════════════════════════════════════════════════════════
 *
 * Lo que se prueba acá no es "que el HTML se vea bonito" —eso se mira con el ojo, y se miró
 * contra la maqueta aprobada— sino las cuatro cosas que si se rompen no dan la cara:
 *
 *   · el logo viaja INCRUSTADO (si vuelve a ser una URL, Gmail lo bloquea y el correo llega
 *     roto justo en el cliente donde más se lee);
 *   · el texto de usuario va ESCAPADO (era una inyección real, ver abajo);
 *   · los tres correos usan el MISMO shell (que es el punto del ticket);
 *   · la firma pública no cambió (para que el camino de entrega siga intacto).
 */

const URL_OK = 'https://app.macha.finance/invitaciones/aceptar?token=abc-123';

describe('el asset de marca', () => {
  test('el logo va incrustado como data URI, no como URL remota', () => {
    /*
     * LA RAZÓN DE FONDO: Gmail y Outlook bloquean imágenes remotas por defecto. Un correo
     * transaccional cuyo trabajo es parecer legítimo se vería con el logo roto hasta que
     * quien lo recibe apriete "mostrar imágenes".
     */
    expect(ISOTIPO_DATA_URI.startsWith('data:image/png;base64,')).toBe(true);
    const html = renderBrandedEmail({
      locale: 'es',
      title: 'x',
      bodyHtml: 'y',
      ctaLabel: 'z',
      ctaUrl: URL_OK,
    });
    expect(html).toContain('src="data:image/png;base64,');
    // Ninguna referencia a una imagen servida por HTTP.
    expect(html).not.toMatch(/<img[^>]+src="https?:/);
  });

  test('los bytes decodifican a un PNG válido', () => {
    const bytes = isotipoPngBytes();
    // Firma PNG: \x89 P N G
    expect([...bytes.slice(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });

  test('la proporción declarada corresponde al PNG real (170x200)', () => {
    // `report-render.ts` escala el logo con esto: si el número miente, el logo del PDF sale
    // deformado, y eso no lanza ningún error.
    expect(ISOTIPO_ASPECTO).toBeCloseTo(0.85, 5);
  });
});

describe('escapado del texto de usuario', () => {
  /**
   * ═══ ESTO ARREGLA UNA INYECCIÓN QUE ESTABA EN PRODUCCIÓN ═══
   *
   * Las plantillas anteriores interpolaban `companyName` e `invitedByEmail` crudos. Los dos
   * son texto que escribe un usuario, así que una empresa podía llamarse
   * `<a href="...">Actualiza tu contraseña</a>` y ese enlace llegaba de verdad, dentro de un
   * correo firmado por `notificaciones@macha.finance`, en un producto financiero.
   */
  test('un nombre de empresa con HTML no produce marcado real', () => {
    const hostil = '<a href="http://phishing.example">Cambia tu clave</a>';
    const html = TEMPLATES.es.invitation(hostil, URL_OK, 'a@b.co').html;

    expect(html).not.toContain('<a href="http://phishing.example"');
    expect(html).toContain('&lt;a href=&quot;http://phishing.example&quot;&gt;');
  });

  test('escapa los cinco caracteres que importan', () => {
    expect(escaparHtml(`<>&"'`)).toBe('&lt;&gt;&amp;&quot;&#39;');
  });

  test('el ampersand no se re-escapa a sí mismo', () => {
    // Si `&` no se procesara primero, "Pérez & Co" saldría como `&amp;amp;`.
    expect(escaparHtml('Pérez & Co')).toBe('Pérez &amp; Co');
    expect(escaparHtml('<b>')).toBe('&lt;b&gt;');
  });

  test('`destacado` también escapa', () => {
    expect(destacado('<script>')).toContain('&lt;script&gt;');
    expect(destacado('<script>')).not.toContain('<script>');
  });

  test('el ASUNTO no se escapa, y es correcto que no lo haga', () => {
    // El asunto es texto plano: escaparlo mostraría `&amp;` literal en la bandeja de entrada.
    expect(TEMPLATES.es.invitation('Pérez & Co', URL_OK, 'a@b.co').subject).toContain('Pérez & Co');
  });
});

describe('la URL del botón', () => {
  test('una URL normal llega intacta', () => {
    const html = renderBrandedEmail({
      locale: 'es',
      title: 't',
      bodyHtml: 'b',
      ctaLabel: 'c',
      ctaUrl: URL_OK,
    });
    expect(html).toContain(`href="${URL_OK}"`);
  });

  test('un esquema que no es http(s) se neutraliza', () => {
    /*
     * Hoy todas estas URL las arma el backend, así que esto no debería poder ocurrir — y por
     * eso mismo el chequeo vale: el día que una empiece a venir de otro lado, falla del lado
     * seguro en vez de convertirse en el vector.
     */
    const html = renderBrandedEmail({
      locale: 'es',
      title: 't',
      bodyHtml: 'b',
      ctaLabel: 'c',
      ctaUrl: 'javascript:alert(1)',
    });
    expect(html).not.toContain('javascript:');
    expect(html).toContain('href="#"');
  });
});

describe('los tres correos usan el shell (el punto del ticket)', () => {
  const casos = [
    ['reportReady', () => TEMPLATES.es.reportReady(URL_OK)],
    ['alertTriggered', () => TEMPLATES.es.alertTriggered('Caída de ingresos', URL_OK)],
    ['invitation', () => TEMPLATES.es.invitation('SNAYDERK', URL_OK, 'jose@u3tech.co')],
  ] as const;

  for (const [nombre, armar] of casos) {
    test(`${nombre} trae la marca completa`, () => {
      const { html, subject } = armar();

      // Las cinco piezas del shell aprobado.
      expect(html).toContain('src="data:image/png;base64,'); // logo
      expect(html).toContain('border-radius:20px'); // tarjeta
      expect(html).toContain('border-radius:100px;background:#0A0A0A'); // botón píldora
      expect(html).toContain('Convierte datos, en decisiones.'); // tagline del pie
      expect(html).toContain(URL_OK); // su enlace

      // Y ya NO es el HTML plano de antes.
      expect(html.startsWith('<p>')).toBe(false);
      expect(subject.length).toBeGreaterThan(0);
    });
  }

  test('la versión en inglés también, con su propio tagline', () => {
    const html = TEMPLATES.en.reportReady(URL_OK).html;
    expect(html).toContain('Turn data into decisions.');
    expect(html).toContain('lang="en"');
    expect(html).not.toContain('Convierte datos');
  });

  test('solo la invitación muestra el enlace en texto y la nota de vencimiento', () => {
    const inv = TEMPLATES.es.invitation('SNAYDERK', URL_OK, 'a@b.co').html;
    const rep = TEMPLATES.es.reportReady(URL_OK).html;

    expect(inv).toContain('O copia y pega este enlace');
    expect(inv).toContain('vence en 7 días');
    // Un reporte va a alguien que ya es usuario: el enlace crudo con ids solo ensucia.
    expect(rep).not.toContain('O copia y pega este enlace');
  });
});

describe('lo que NO cambió', () => {
  /**
   * El shell se insertó por debajo a propósito: `deliverEmail()`, la cola `email.send` y la
   * tabla `notifications` siguen recibiendo lo mismo. Si esta forma cambiara, el arreglo
   * visual habría tocado el camino de entrega, que ya funciona.
   */
  test('cada plantilla sigue devolviendo exactamente { subject, html }', () => {
    const t = TEMPLATES.es.reportReady(URL_OK);
    expect(Object.keys(t).sort()).toEqual(['html', 'subject']);
    expect(typeof t.subject).toBe('string');
    expect(typeof t.html).toBe('string');
  });

  test('siguen existiendo los tres tipos, en los dos idiomas', () => {
    for (const locale of ['es', 'en'] as const) {
      expect(Object.keys(TEMPLATES[locale]).sort()).toEqual([
        'alertTriggered',
        'invitation',
        'reportReady',
      ]);
    }
  });
});
