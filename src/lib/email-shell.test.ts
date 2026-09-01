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
  test('el logo del CORREO va por URL pública, no como data URI', () => {
    /*
     * ═══ ESTE TEST AFIRMABA LO CONTRARIO, Y ESTABA MAL ═══
     *
     * Decía: "Gmail y Outlook bloquean imágenes remotas por defecto, un correo se vería con
     * el logo roto hasta que quien lo recibe apriete mostrar imágenes". Las dos mitades están
     * al revés, y el resultado fue el logo roto que reportó Jose:
     *
     *   · Gmail SÍ carga imágenes remotas, desde 2013, por su propio proxy
     *     (`googleusercontent.com`) y sin preguntarle a quien lee.
     *   · Gmail NO renderiza `data:` URIs en el cuerpo de un correo: los descarta.
     *
     * Se había elegido el único formato que Gmail no soporta para esquivar un bloqueo que
     * dejó de existir hace más de una década. El test pasaba porque probaba que el código
     * hacía lo que el código hacía.
     */
    const html = renderBrandedEmail({
      locale: 'es',
      title: 'x',
      bodyHtml: 'y',
      ctaLabel: 'z',
      ctaUrl: URL_OK,
    });

    expect(html).toContain('/brand/isotipo.png');
    // Y NINGÚN data URI: es lo que Gmail descarta.
    expect(html).not.toContain('src="data:image');
  });

  test('el logo lleva `width` y `height` en el atributo, no solo en el estilo', () => {
    /*
     * Outlook (motor de Word) ignora `width`/`height` en CSS para imágenes. Sin los
     * atributos, reserva el tamaño NATURAL del PNG —170x200— y el logo sale gigante,
     * empujando el resto de la tarjeta.
     *
     * Los valores salen del aspecto real (170/200 = 0,85), no de un redondeo cómodo: a 36px
     * de alto son 31 de ancho. Un ancho inventado deforma el isotipo, que es justo lo que un
     * correo de marca no puede permitirse.
     */
    const html = renderBrandedEmail({
      locale: 'es',
      title: 'x',
      bodyHtml: 'y',
      ctaLabel: 'z',
      ctaUrl: URL_OK,
    });

    expect(html).toContain('width="31" height="36"');
    expect(Math.round(36 * ISOTIPO_ASPECTO)).toBe(31);
  });

  test('el data URI se conserva para el HTML que se ve en un navegador', () => {
    // El PDF del reporte y el HTML autenticado sí lo pueden usar: se abren fuera de un
    // cliente de correo, y en el caso del PDF a veces sin red.
    expect(ISOTIPO_DATA_URI.startsWith('data:image/png;base64,')).toBe(true);
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
      expect(html).toContain('/brand/isotipo.png'); // logo, servido públicamente
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

  test('existen los cinco tipos, en los dos idiomas', () => {
    /*
     * La lista se escribe entera a propósito: un `toContain` dejaría pasar que una plantilla
     * exista solo en español, y el cliente en inglés recibiría un `undefined` renderizado.
     *
     * `reviewNeeded` se sumó en CU-868kyur58. Ojo si aparece un tipo nuevo: además de esta
     * lista hay que ampliar el CHECK de `notifications.kind` (migración 0041) — el tipo de
     * TypeScript no es el que manda, y saltárselo mueve el fallo a producción, después de que
     * el correo ya salió.
     */
    for (const locale of ['es', 'en'] as const) {
      expect(Object.keys(TEMPLATES[locale]).sort()).toEqual([
        'alertTriggered',
        'demoRequest',
        'invitation',
        'reportReady',
        'reviewNeeded',
      ]);
    }
  });

  test('el correo de revisión se arma sobre el shell de marca, en los dos idiomas', () => {
    for (const locale of ['es', 'en'] as const) {
      const t = TEMPLATES[locale].reviewNeeded({
        archivos: ['Ventas_Agosto.xlsx'],
        conceptos: 2,
        ctaUrl: URL_OK,
      });
      expect(Object.keys(t).sort()).toEqual(['html', 'subject']);
      // El nombre del archivo va en el ASUNTO: sin él, "tu archivo necesita tu atención" no
      // dice cuál, y un cliente que subió tres no sabe a cuál volver.
      expect(t.subject).toContain('Ventas_Agosto.xlsx');
      expect(t.html).toContain(URL_OK);
      // El pie corrige el malentendido de la promoción parcial y tiene que seguir ahí.
      expect(t.html.toLowerCase()).toContain('dashboard');
    }
  });

  test('con varias cargas el asunto NO nombra una sola', () => {
    // Nombrar solo la primera de tres es peor que no nombrar ninguna: el cliente cree que el
    // aviso es de ese archivo y deja los otros dos sin contestar.
    const t = TEMPLATES.es.reviewNeeded({
      archivos: ['A.xlsx', 'B.xlsx'],
      conceptos: 3,
      ctaUrl: URL_OK,
    });
    expect(t.subject).not.toContain('A.xlsx');
    expect(t.html).toContain('A.xlsx');
    expect(t.html).toContain('B.xlsx');
  });
});
