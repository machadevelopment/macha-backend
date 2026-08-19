import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import { svgBarrasDeCosto, svgTendencia } from '@/lib/report-charts';
import * as XLSX from 'xlsx';
import type { ReportData, ReportSection } from '@/lib/report-sections';

/**
 * RENDERIZADO DE UN REPORTE A SUS TRES FORMATOS (CU-B2-QA-20260811).
 *
 * Entra siempre lo mismo —el `ReportData` ya calculado más la narrativa ya generada— y
 * sale HTML, PDF o XLSX. Ningún render toca la base ni llama a Claude: se puede
 * reconstruir cualquier formato de una versión vieja sin volver a gastar un token, que es
 * justamente lo que permite generar el PDF y el Excel bajo demanda en vez de fabricar los
 * tres al crear el reporte (ver `reportPdfKey` en lib/s3.ts).
 *
 * ─────────────────────────────────────────────────────────────────────────────────────
 * POR QUÉ pdf-lib Y NO OTRA COSA (verificación de compatibilidad con Bun, no negociable)
 * ─────────────────────────────────────────────────────────────────────────────────────
 * Descartadas ANTES de instalar nada:
 *  - `puppeteer` / `playwright` (HTML→PDF): descargan y ejecutan un Chromium. Es un
 *    binario nativo por plataforma dentro de un contenedor de Railway y un salto de
 *    cientos de MB en la imagen. Node-only en la práctica y desproporcionado.
 *  - `pdfkit`: depende de streams de Node y lee sus fuentes del sistema de archivos del
 *    paquete; funciona a medias fuera de Node y su modo de fallo es en runtime.
 *  - `@react-pdf/renderer`: arrastra un reconciliador de React entero al backend.
 *
 * Elegida: `pdf-lib` (MIT). JavaScript puro, sin node-gyp, sin binarios, sin lectura de
 * disco: sus únicas dependencias son `@pdf-lib/standard-fonts`, `@pdf-lib/upng`, `pako` y
 * `tslib`, todas puras. VERIFICADO EJECUTÁNDOLO EN ESTE BUN (1.3.14): genera un PDF con
 * cabecera `%PDF-1.7` y mide texto correctamente con acentos, «ñ», «·» y «—».
 *
 * Para Excel NO se instaló nada: `xlsx` (SheetJS) YA es dependencia del repo para leer
 * los libros de la ingesta, y la misma librería escribe. Verificado también bajo Bun:
 * `XLSX.write(..., { type: 'buffer' })` devuelve un Buffer válido.
 *
 * LA TRAMPA DE pdf-lib, comprobada y no supuesta: las 14 fuentes estándar de PDF
 * codifican en WinAnsi, y `drawText` LANZA con cualquier carácter fuera de ese juego
 * (`WinAnsi cannot encode "🚀" (0x1f680)`). Los acentos y la puntuación española sí
 * entran; un emoji o un carácter CJK en una narrativa generada por IA, o en el nombre de
 * un producto que venga del Excel del cliente, no. Por eso TODO texto pasa por
 * `sanitizeWinAnsi` antes de dibujarse: un reporte con un carácter sustituido es un
 * problema cosmético, un job que revienta al exportar es un reporte que no existe.
 */

// ---------------------------------------------------------------------------
// Formato de cifras
// ---------------------------------------------------------------------------

/**
 * El equivalente de servidor de `lib/format` del frontend: la moneda SIEMPRE con su
 * código explícito (GTQ/USD), nunca un símbolo suelto, y el separador según el locale de
 * la empresa. Un PDF se manda por correo y se imprime fuera de la aplicación, así que es
 * el sitio donde una cifra ambigua más caro sale.
 */
export function formatMoney(value: number, currency: string, locale: 'es' | 'en'): string {
  const nf = new Intl.NumberFormat(locale === 'es' ? 'es-GT' : 'en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `${currency} ${nf.format(value)}`;
}

export function formatPct(value: number | null, locale: 'es' | 'en'): string {
  if (value === null || !Number.isFinite(value)) {
    return locale === 'es' ? 'sin ventas en el período' : 'no sales in period';
  }
  const nf = new Intl.NumberFormat(locale === 'es' ? 'es-GT' : 'en-US', {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  });
  return `${nf.format(value)} %`;
}

// ---------------------------------------------------------------------------
// Etiquetas
// ---------------------------------------------------------------------------

export const SECTION_LABELS: Record<ReportSection, { es: string; en: string }> = {
  kpis: { es: 'Indicadores del período', en: 'Period indicators' },
  revenue_trend: { es: 'Evolución de ingresos', en: 'Revenue trend' },
  cost_breakdown: { es: 'Desglose de costos', en: 'Cost breakdown' },
  top_products: { es: 'Productos principales', en: 'Top products' },
  risks: { es: 'Riesgos', en: 'Risks' },
  recommendations: { es: 'Recomendaciones', en: 'Recommendations' },
};

export interface RenderInput {
  companyName: string;
  baseCurrency: string;
  locale: 'es' | 'en';
  data: ReportData;
  narrative: string;
}

// ---------------------------------------------------------------------------
// HTML
// ---------------------------------------------------------------------------

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function htmlTable(headers: string[], rows: string[][]): string {
  const th = headers.map((h) => `<th>${escapeHtml(h)}</th>`).join('');
  const tr = rows
    .map((r) => `<tr>${r.map((c) => `<td>${escapeHtml(c)}</td>`).join('')}</tr>`)
    .join('');
  return `<table><thead><tr>${th}</tr></thead><tbody>${tr}</tbody></table>`;
}

/**
 * El HTML es el render que ya existía (`report_versions.s3_render_key`) y sigue siendo el
 * canónico: es lo que abre `GET /reports/:id/view`. Lo que cambia con este ticket es que
 * ahora recorre las SECCIONES en vez de imprimir siempre el mismo párrafo de KPIs.
 *
 * Los estilos van embebidos y en gris/salvia sobrio a propósito: el objeto vive en S3 y se
 * abre por URL prefirmada, fuera de la aplicación, así que no tiene acceso a los tokens de
 * diseño del frontend y no puede depender de ninguna hoja externa.
 */
export function renderReportHtml(input: RenderInput): string {
  const { data, locale, baseCurrency } = input;
  const L = <T>(o: { es: T; en: T }) => o[locale];
  const money = (n: number) => formatMoney(n, baseCurrency, locale);
  const bloques: string[] = [];

  if (data.kpis) {
    const k = data.kpis;
    bloques.push(
      `<section><h2>${escapeHtml(L(SECTION_LABELS.kpis))}</h2>${htmlTable(
        [L({ es: 'Concepto', en: 'Concept' }), L({ es: 'Monto', en: 'Amount' })],
        [
          [L({ es: 'Ingresos', en: 'Revenue' }), money(k.revenue)],
          [L({ es: 'Costo directo de ventas', en: 'Cost of goods sold' }), money(k.cogs)],
          [L({ es: 'Gasto operativo', en: 'Operating expense' }), money(k.opex)],
          [L({ es: 'Otros', en: 'Other' }), money(k.other)],
          [L({ es: 'Utilidad bruta', en: 'Gross profit' }), money(k.grossProfit)],
          [L({ es: 'Margen bruto', en: 'Gross margin' }), formatPct(k.grossMarginPct, locale)],
          [
            L({ es: 'Por cobrar abierto', en: 'Open receivables' }),
            money(k.accountsReceivableOpen),
          ],
          [L({ es: 'Por pagar abierto', en: 'Open payables' }), money(k.accountsPayableOpen)],
        ],
      )}</section>`,
    );
  }

  if (data.revenueTrend) {
    const t = data.revenueTrend;
    /*
     * CU-868kt4ap8: la gráfica va ANTES de la tabla, no después.
     *
     * La tabla da las cifras exactas y la gráfica da la forma. Quien abre un reporte quiere
     * primero saber si subió o cayó —eso se ve en un segundo— y solo después el número. Al
     * revés, la figura queda de adorno al final de una sección que el lector ya cerró.
     *
     * Cadena vacía cuando la serie no da para dibujar (menos de dos puntos): se omite en
     * lugar de dejar un hueco, y la tabla sigue estando.
     */
    const grafica = svgTendencia(t.series, {
      entradas: L({ es: 'Entradas', en: 'Money in' }),
      salidas: L({ es: 'Salidas', en: 'Money out' }),
    });
    const leyenda = grafica
      ? `<p class="leyenda"><span class="k k-in"></span>${escapeHtml(L({ es: 'Entradas', en: 'Money in' }))} <span class="k k-out"></span>${escapeHtml(L({ es: 'Salidas (costo directo + operativo)', en: 'Money out (direct + operating)' }))}</p>`
      : '';
    bloques.push(
      `<section><h2>${escapeHtml(L(SECTION_LABELS.revenue_trend))}</h2>${grafica}${leyenda}${htmlTable(
        [
          L({ es: 'Ventana', en: 'Window' }),
          L({ es: 'Ingresos', en: 'Revenue' }),
          L({ es: 'Costo directo', en: 'Direct cost' }),
          L({ es: 'Gasto operativo', en: 'Operating expense' }),
        ],
        [
          [
            L({ es: 'Período', en: 'Period' }),
            money(t.current.revenue),
            money(t.current.cogs),
            money(t.current.opex),
          ],
          [
            L({ es: 'Ventana anterior', en: 'Previous window' }),
            money(t.previous.revenue),
            money(t.previous.cogs),
            money(t.previous.opex),
          ],
        ],
      )}</section>`,
    );
  }

  if (data.costBreakdown) {
    bloques.push(
      `<section><h2>${escapeHtml(L(SECTION_LABELS.cost_breakdown))}</h2>${
        data.costBreakdown.length === 0
          ? `<p>${escapeHtml(L({ es: 'Sin costos registrados en el período.', en: 'No costs recorded in the period.' }))}</p>`
          : svgBarrasDeCosto(data.costBreakdown) +
            htmlTable(
              [
                L({ es: 'Categoría', en: 'Category' }),
                L({ es: 'Tipo', en: 'Type' }),
                L({ es: 'Total', en: 'Total' }),
                L({ es: 'Participación', en: 'Share' }),
              ],
              data.costBreakdown.map((c) => [
                c.category,
                c.type,
                money(c.total),
                formatPct(c.sharePct, locale),
              ]),
            )
      }</section>`,
    );
  }

  if (data.topProducts) {
    bloques.push(
      `<section><h2>${escapeHtml(L(SECTION_LABELS.top_products))}</h2>${
        data.topProducts.length === 0
          ? `<p>${escapeHtml(L({ es: 'La ingesta no identificó productos en este rango.', en: 'Ingestion identified no products in this range.' }))}</p>`
          : htmlTable(
              [
                L({ es: 'Producto', en: 'Product' }),
                L({ es: 'Ingreso', en: 'Revenue' }),
                L({ es: 'Utilidad bruta', en: 'Gross profit' }),
                L({ es: 'Margen', en: 'Margin' }),
                L({ es: 'Tendencia', en: 'Trend' }),
              ],
              data.topProducts.map((p) => [
                p.name,
                money(p.revenue),
                money(p.grossProfit),
                formatPct(p.grossMarginPct, locale),
                p.trend,
              ]),
            )
      }</section>`,
    );
  }

  if (data.risks) {
    const r = data.risks;
    bloques.push(
      `<section><h2>${escapeHtml(L(SECTION_LABELS.risks))}</h2>${
        r.alerts.length === 0
          ? `<p>${escapeHtml(L({ es: 'Ninguna alerta disparó en el período.', en: 'No alerts fired during the period.' }))}</p>`
          : htmlTable(
              [
                L({ es: 'Alerta', en: 'Alert' }),
                L({ es: 'Valor', en: 'Value' }),
                L({ es: 'Umbral', en: 'Threshold' }),
                L({ es: 'Fecha', en: 'Date' }),
              ],
              r.alerts.map((a) => [
                a.label,
                a.unit === 'days' ? `${a.triggeredValue}` : formatPct(a.triggeredValue, locale),
                a.unit === 'days' ? `${a.threshold}` : formatPct(a.threshold, locale),
                a.occurredAt.slice(0, 10),
              ]),
            )
      }<p class="nota">${escapeHtml(
        L({
          es: `Antigüedad de cartera medida al ${r.agingAsOf} (estado vivo, no al cierre del período).`,
          en: `Ageing measured as of ${r.agingAsOf} (live state, not at period close).`,
        }),
      )}</p>${htmlTable(
        [
          L({ es: 'Antigüedad', en: 'Ageing' }),
          L({ es: 'Por cobrar', en: 'Receivable' }),
          L({ es: 'Por pagar', en: 'Payable' }),
        ],
        Object.keys(r.arAging).map((b) => [
          b,
          money(r.arAging[b as keyof typeof r.arAging]),
          money(r.apAging[b as keyof typeof r.apAging]),
        ]),
      )}</section>`,
    );
  }

  const titulo = L({ es: 'Reporte ejecutivo', en: 'Executive report' });
  return `<!doctype html><html lang="${locale}"><head><meta charset="utf-8"><title>${escapeHtml(
    `${titulo} ${data.periodStart} — ${data.periodEnd}`,
  )}</title><style>
body{font-family:-apple-system,"Segoe UI",Inter,system-ui,sans-serif;color:#1c1c1c;margin:0;padding:40px;line-height:1.55}
header{border-bottom:3px solid #A0AF9A;padding-bottom:16px;margin-bottom:28px}
h1{font-size:22px;margin:0 0 4px}h2{font-size:15px;margin:28px 0 10px;text-transform:uppercase;letter-spacing:.06em;color:#5c6b57}
.meta{color:#6b6b6b;font-size:13px}
table{border-collapse:collapse;width:100%;font-size:13px;font-variant-numeric:tabular-nums}
th,td{text-align:left;padding:6px 10px;border-bottom:1px solid #e6e6e6}
th{color:#6b6b6b;font-weight:600}
td:not(:first-child){text-align:right}
.nota{font-size:12px;color:#6b6b6b}
.narrativa{white-space:pre-wrap;margin-top:28px}
/* CU-868kt4ap8 — leyenda de la gráfica de tendencia. Va DEBAJO de la figura y en 12px:
   la gráfica muestra la forma, la leyenda solo dice qué es cada línea, y la cifra exacta
   la da la tabla de al lado. Las llaves de color son cuadraditos y no solo texto teñido,
   porque el color de estado nunca aparece solo (design guide §1 regla 3). */
.leyenda{font-size:12px;color:#6b6b6b;margin:6px 0 14px}
.k{display:inline-block;width:9px;height:9px;border-radius:2px;margin:0 5px 0 12px;vertical-align:middle}
.leyenda .k:first-child{margin-left:0}
.k-in{background:#16A34A}
.k-out{background:#DC2626}
svg{margin:4px 0 2px}
</style></head>
<body>
  <header>
    <h1>${escapeHtml(`${titulo} — ${input.companyName}`)}</h1>
    <p class="meta">${escapeHtml(`${data.periodStart} — ${data.periodEnd}`)} · ${escapeHtml(baseCurrency)}</p>
  </header>
  ${bloques.join('\n  ')}
  <div class="narrativa">${escapeHtml(input.narrative)}</div>
</body></html>`;
}

// ---------------------------------------------------------------------------
// PDF
// ---------------------------------------------------------------------------

/**
 * Sustituye lo que las fuentes estándar de PDF no pueden codificar (ver la nota de
 * cabecera). Se traducen primero los sospechosos habituales de un texto generado —comillas
 * tipográficas, puntos suspensivos, guiones largos— porque tienen equivalente obvio y
 * sustituirlos por '?' se vería como un error de datos; el resto cae a '?'.
 *
 * Exportada para poder probarla sin construir un PDF: es la única pieza de este archivo
 * cuyo fallo no se ve hasta que un cliente exporta.
 */
export function sanitizeWinAnsi(text: string): string {
  const reemplazos: Record<string, string> = {
    '‘': "'",
    '’': "'",
    '“': '"',
    '”': '"',
    '…': '...',
    '–': '-',
    '—': '-',
    ' ': ' ',
    '•': '-',
    '→': '->',
    '\t': '    ',
  };
  let out = '';
  for (const ch of text) {
    const alt = reemplazos[ch];
    if (alt !== undefined) {
      out += alt;
      continue;
    }
    const code = ch.codePointAt(0)!;
    // ASCII imprimible + salto de línea + Latin-1 alto (donde viven á é í ó ú ñ ¿ ¡).
    if (
      ch === '\n' ||
      (code >= 0x20 && code <= 0x7e) ||
      (code >= 0xa0 && code <= 0xff) ||
      WINANSI_EXTRA.has(ch)
    ) {
      out += ch;
    } else {
      out += '?';
    }
  }
  return out;
}

/**
 * WinAnsi NO es Latin-1: en el tramo 0x80–0x9F, donde Latin-1 tiene controles, WinAnsi
 * mete caracteres imprimibles. El más importante para nosotros es el símbolo del euro,
 * que un rango `0xa0–0xff` deja fuera y convertiría en '?' pese a que la fuente sí lo
 * sabe dibujar. Se listan los que sobreviven al mapa de reemplazos de arriba.
 */
const WINANSI_EXTRA = new Set([
  '€',
  'ƒ',
  '†',
  '‡',
  'ˆ',
  '‰',
  'Š',
  '‹',
  'Œ',
  'Ž',
  '˜',
  '™',
  'š',
  '›',
  'œ',
  'ž',
  'Ÿ',
]);

/** Parte un texto en líneas que caben en `maxWidth` a `size`, respetando saltos duros. */
export function wrapText(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const lineas: string[] = [];
  for (const parrafo of text.split('\n')) {
    if (parrafo.trim() === '') {
      lineas.push('');
      continue;
    }
    let actual = '';
    for (const palabra of parrafo.split(/\s+/)) {
      const tentativa = actual ? `${actual} ${palabra}` : palabra;
      if (font.widthOfTextAtSize(tentativa, size) <= maxWidth) {
        actual = tentativa;
      } else {
        if (actual) lineas.push(actual);
        actual = palabra;
      }
    }
    if (actual) lineas.push(actual);
  }
  return lineas;
}

const PAGE = { width: 595.28, height: 841.89, margin: 48 };
const CONTENT_WIDTH = PAGE.width - PAGE.margin * 2;
const SALVIA = rgb(0.627, 0.686, 0.604); // #A0AF9A — verde de MARCA, nunca sobre un dato.
const TINTA = rgb(0.11, 0.11, 0.11);
const GRIS = rgb(0.42, 0.42, 0.42);
/*
 * CU-868kt4ap8 — verde y rojo FUNCIONALES para las series de la gráfica.
 *
 * NO se reusa `SALVIA`: el verde de marca dice "esto es Macha" y la regla de los dos verdes
 * le prohíbe expresamente ir sobre un dato. Estos dos dicen "entra" y "sale", que es
 * justamente el rol que la regla reserva al color funcional.
 */
const VERDE_FUNCIONAL = rgb(0.086, 0.639, 0.29); // #16A34A
const ROJO_FUNCIONAL = rgb(0.863, 0.149, 0.149); // #DC2626

export async function renderReportPdf(input: RenderInput): Promise<Uint8Array> {
  const { data, locale, baseCurrency } = input;
  const L = <T>(o: { es: T; en: T }) => o[locale];
  const money = (n: number) => formatMoney(n, baseCurrency, locale);

  const doc = await PDFDocument.create();
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  let page: PDFPage = doc.addPage([PAGE.width, PAGE.height]);
  let y = PAGE.height - PAGE.margin;

  const nuevaPagina = () => {
    page = doc.addPage([PAGE.width, PAGE.height]);
    y = PAGE.height - PAGE.margin;
  };
  const espacio = (alto: number) => {
    if (y - alto < PAGE.margin) nuevaPagina();
  };
  const texto = (
    raw: string,
    opts: { size?: number; font?: PDFFont; color?: ReturnType<typeof rgb>; x?: number } = {},
  ) => {
    const size = opts.size ?? 10;
    const font = opts.font ?? regular;
    for (const linea of wrapText(sanitizeWinAnsi(raw), font, size, CONTENT_WIDTH)) {
      espacio(size + 4);
      y -= size + 4;
      if (linea)
        page.drawText(linea, {
          x: opts.x ?? PAGE.margin,
          y,
          size,
          font,
          color: opts.color ?? TINTA,
        });
    }
  };
  const titulo2 = (raw: string) => {
    espacio(34);
    y -= 22;
    page.drawText(sanitizeWinAnsi(raw.toUpperCase()), {
      x: PAGE.margin,
      y,
      size: 10,
      font: bold,
      color: GRIS,
    });
    y -= 6;
    page.drawRectangle({ x: PAGE.margin, y, width: CONTENT_WIDTH, height: 0.8, color: SALVIA });
    y -= 4;
  };
  /** Tabla de ancho fijo; la última columna alineada a la derecha, como en la UI. */
  const tabla = (headers: string[], rows: string[][], anchos: number[]) => {
    const dibujarFila = (celdas: string[], font: PDFFont, color = TINTA) => {
      espacio(15);
      y -= 14;
      let x = PAGE.margin;
      celdas.forEach((celda, i) => {
        const w = CONTENT_WIDTH * anchos[i]!;
        const limpia = sanitizeWinAnsi(celda);
        // Recorte por ancho real, no por número de caracteres: un nombre de producto
        // largo pisaría la columna siguiente.
        let visible = limpia;
        while (visible.length > 1 && font.widthOfTextAtSize(visible, 9) > w - 6) {
          visible = visible.slice(0, -1);
        }
        const alineaDerecha = i > 0;
        const ancho = font.widthOfTextAtSize(visible, 9);
        page.drawText(visible, {
          x: alineaDerecha ? x + w - 6 - ancho : x,
          y,
          size: 9,
          font,
          color,
        });
        x += w;
      });
    };
    dibujarFila(headers, bold, GRIS);
    for (const r of rows) dibujarFila(r, regular);
  };

  // Cabecera
  page.drawRectangle({
    x: PAGE.margin,
    y: y - 4,
    width: CONTENT_WIDTH,
    height: 3,
    color: SALVIA,
  });
  y -= 26;
  page.drawText(
    sanitizeWinAnsi(
      `${L({ es: 'Reporte ejecutivo', en: 'Executive report' })} — ${input.companyName}`,
    ),
    { x: PAGE.margin, y, size: 16, font: bold, color: TINTA },
  );
  y -= 16;
  page.drawText(sanitizeWinAnsi(`${data.periodStart} — ${data.periodEnd} · ${baseCurrency}`), {
    x: PAGE.margin,
    y,
    size: 10,
    font: regular,
    color: GRIS,
  });
  y -= 8;

  if (data.kpis) {
    const k = data.kpis;
    titulo2(L(SECTION_LABELS.kpis));
    tabla(
      [L({ es: 'Concepto', en: 'Concept' }), L({ es: 'Monto', en: 'Amount' })],
      [
        [L({ es: 'Ingresos', en: 'Revenue' }), money(k.revenue)],
        [L({ es: 'Costo directo de ventas', en: 'Cost of goods sold' }), money(k.cogs)],
        [L({ es: 'Gasto operativo', en: 'Operating expense' }), money(k.opex)],
        [L({ es: 'Otros', en: 'Other' }), money(k.other)],
        [L({ es: 'Utilidad bruta', en: 'Gross profit' }), money(k.grossProfit)],
        [L({ es: 'Margen bruto', en: 'Gross margin' }), formatPct(k.grossMarginPct, locale)],
        [L({ es: 'Por cobrar abierto', en: 'Open receivables' }), money(k.accountsReceivableOpen)],
        [L({ es: 'Por pagar abierto', en: 'Open payables' }), money(k.accountsPayableOpen)],
      ],
      [0.6, 0.4],
    );
  }

  /**
   * La misma tendencia del HTML, dibujada con primitivas — CU-868kt4ap8.
   *
   * `pdf-lib` no interpreta SVG, así que la figura se traza con rectángulos. Se eligen
   * BARRAS y no una línea por una razón práctica: una polilínea en pdf-lib son N llamadas a
   * `drawLine` con sus uniones a mano, y a 366 puntos eso es un PDF pesado y una curva
   * dentada. Las barras agregan bien, se leen impresas y no mienten sobre la forma.
   *
   * Los colores son los FUNCIONALES (verde entra / rojo sale), nunca el salvia de marca:
   * el salvia dice "esto es Macha" y no puede ir sobre un dato.
   */
  const graficaTendencia = (serie: { revenue: number; cogs: number; opex: number }[]) => {
    if (serie.length < 2) return;
    // Como mucho 24 barras: más que eso, en el ancho de una hoja carta, son rayas de menos
    // de 2pt que no se distinguen entre sí. Se agrega por bloques iguales.
    const MAX_BARRAS = 24;
    const porBloque = Math.ceil(serie.length / MAX_BARRAS);
    const bloques: { entra: number; sale: number }[] = [];
    for (let i = 0; i < serie.length; i += porBloque) {
      const trozo = serie.slice(i, i + porBloque);
      bloques.push({
        entra: trozo.reduce((a, p) => a + p.revenue, 0),
        sale: trozo.reduce((a, p) => a + p.cogs + p.opex, 0),
      });
    }
    const maximo = Math.max(...bloques.map((b) => Math.max(b.entra, b.sale)));
    if (maximo <= 0) return;

    const alto = 90;
    espacio(alto + 12);
    const base = y - alto;
    const anchoBloque = CONTENT_WIDTH / bloques.length;
    // Dos barras por bloque, con un pelo de aire entre bloques.
    const anchoBarra = Math.max(1.2, (anchoBloque - 2) / 2);

    for (const [i, b] of bloques.entries()) {
      const x = PAGE.margin + anchoBloque * i;
      page.drawRectangle({
        x,
        y: base,
        width: anchoBarra,
        height: (b.entra / maximo) * alto,
        color: VERDE_FUNCIONAL,
      });
      page.drawRectangle({
        x: x + anchoBarra,
        y: base,
        width: anchoBarra,
        height: (b.sale / maximo) * alto,
        color: ROJO_FUNCIONAL,
      });
    }
    // Línea de base: sin ella las barras flotan y no se lee de dónde arrancan.
    page.drawRectangle({ x: PAGE.margin, y: base, width: CONTENT_WIDTH, height: 0.6, color: GRIS });
    y = base - 10;
    texto(
      L({
        es: 'Barras verdes: entradas. Barras rojas: salidas (costo directo + operativo).',
        en: 'Green bars: money in. Red bars: money out (direct + operating).',
      }),
      { size: 8, color: GRIS },
    );
    y -= 6;
  };

  if (data.revenueTrend) {
    const t = data.revenueTrend;
    titulo2(L(SECTION_LABELS.revenue_trend));
    graficaTendencia(t.series);
    tabla(
      [
        L({ es: 'Ventana', en: 'Window' }),
        L({ es: 'Ingresos', en: 'Revenue' }),
        L({ es: 'Costo directo', en: 'Direct cost' }),
        L({ es: 'Gasto oper.', en: 'Op. expense' }),
      ],
      [
        [
          L({ es: 'Período', en: 'Period' }),
          money(t.current.revenue),
          money(t.current.cogs),
          money(t.current.opex),
        ],
        [
          L({ es: 'Ventana anterior', en: 'Previous window' }),
          money(t.previous.revenue),
          money(t.previous.cogs),
          money(t.previous.opex),
        ],
      ],
      [0.28, 0.24, 0.24, 0.24],
    );
  }

  if (data.costBreakdown) {
    titulo2(L(SECTION_LABELS.cost_breakdown));
    if (data.costBreakdown.length === 0) {
      texto(
        L({ es: 'Sin costos registrados en el período.', en: 'No costs recorded in the period.' }),
        {
          color: GRIS,
        },
      );
    } else {
      tabla(
        [
          L({ es: 'Categoría', en: 'Category' }),
          L({ es: 'Tipo', en: 'Type' }),
          L({ es: 'Total', en: 'Total' }),
          L({ es: 'Participación', en: 'Share' }),
        ],
        data.costBreakdown.map((c) => [
          c.category,
          c.type,
          money(c.total),
          formatPct(c.sharePct, locale),
        ]),
        [0.34, 0.16, 0.28, 0.22],
      );
    }
  }

  if (data.topProducts) {
    titulo2(L(SECTION_LABELS.top_products));
    if (data.topProducts.length === 0) {
      texto(
        L({
          es: 'La ingesta no identificó productos en este rango.',
          en: 'Ingestion identified no products in this range.',
        }),
        { color: GRIS },
      );
    } else {
      tabla(
        [
          L({ es: 'Producto', en: 'Product' }),
          L({ es: 'Ingreso', en: 'Revenue' }),
          L({ es: 'Utilidad bruta', en: 'Gross profit' }),
          L({ es: 'Margen', en: 'Margin' }),
        ],
        data.topProducts.map((p) => [
          p.name,
          money(p.revenue),
          money(p.grossProfit),
          formatPct(p.grossMarginPct, locale),
        ]),
        [0.34, 0.24, 0.24, 0.18],
      );
    }
  }

  if (data.risks) {
    const r = data.risks;
    titulo2(L(SECTION_LABELS.risks));
    if (r.alerts.length === 0) {
      texto(
        L({
          es: 'Ninguna alerta disparó en el período.',
          en: 'No alerts fired during the period.',
        }),
        { color: GRIS },
      );
    } else {
      tabla(
        [
          L({ es: 'Alerta', en: 'Alert' }),
          L({ es: 'Valor', en: 'Value' }),
          L({ es: 'Umbral', en: 'Threshold' }),
          L({ es: 'Fecha', en: 'Date' }),
        ],
        r.alerts.map((a) => [
          a.label,
          a.unit === 'days' ? String(a.triggeredValue) : formatPct(a.triggeredValue, locale),
          a.unit === 'days' ? String(a.threshold) : formatPct(a.threshold, locale),
          a.occurredAt.slice(0, 10),
        ]),
        [0.4, 0.2, 0.2, 0.2],
      );
    }
    texto(
      L({
        es: `Antigüedad de cartera medida al ${r.agingAsOf} (estado vivo, no al cierre del período).`,
        en: `Ageing measured as of ${r.agingAsOf} (live state, not at period close).`,
      }),
      { size: 8, color: GRIS },
    );
    tabla(
      [
        L({ es: 'Antigüedad', en: 'Ageing' }),
        L({ es: 'Por cobrar', en: 'Receivable' }),
        L({ es: 'Por pagar', en: 'Payable' }),
      ],
      Object.keys(r.arAging).map((b) => [
        b,
        money(r.arAging[b as keyof typeof r.arAging]),
        money(r.apAging[b as keyof typeof r.apAging]),
      ]),
      [0.34, 0.33, 0.33],
    );
  }

  titulo2(L({ es: 'Análisis', en: 'Analysis' }));
  texto(input.narrative, { size: 10 });

  return doc.save();
}

// ---------------------------------------------------------------------------
// XLSX
// ---------------------------------------------------------------------------

/**
 * Excel: RESUMEN CONSOLIDADO (ventas, gastos, utilidad, margen) en la primera hoja, que es
 * lo que pide el ticket, más una hoja por sección con datos tabulares que el reporte ya
 * traiga. Las hojas extra no son adorno: quien abre el Excel en vez del PDF lo hace para
 * seguir calculando, y devolverle cuatro totales cuando el reporte ya tiene el detalle
 * por categoría o por producto lo obligaría a volver al dashboard a copiarlo.
 *
 * Los montos se escriben como NÚMEROS, no como texto formateado: un Excel cuyas cifras no
 * suman es peor que no tener Excel. La moneda va en el encabezado de la columna.
 *
 * "Gastos" del resumen = costo directo + gasto operativo. Se listan además por separado
 * porque la definición de margen bruto del PRD (utilidad bruta = ingreso − costo directo,
 * SIN restar gasto operativo, lib/margin.ts) depende de no confundirlos.
 */
export function renderReportXlsx(input: RenderInput): Buffer {
  const { data, locale, baseCurrency } = input;
  const L = <T>(o: { es: T; en: T }) => o[locale];
  const wb = XLSX.utils.book_new();

  const k = data.kpis;
  const resumen: (string | number | null)[][] = [
    [L({ es: 'Reporte ejecutivo', en: 'Executive report' }), input.companyName],
    [L({ es: 'Período', en: 'Period' }), `${data.periodStart} — ${data.periodEnd}`],
    [L({ es: 'Moneda base', en: 'Base currency' }), baseCurrency],
    [L({ es: 'Secciones', en: 'Sections' }), data.sections.join(', ')],
    [],
    [L({ es: 'Concepto', en: 'Concept' }), `${L({ es: 'Monto', en: 'Amount' })} (${baseCurrency})`],
  ];

  if (k) {
    const gastos = k.cogs + k.opex;
    resumen.push(
      [L({ es: 'Ventas', en: 'Sales' }), k.revenue],
      [L({ es: 'Costo directo de ventas', en: 'Cost of goods sold' }), k.cogs],
      [L({ es: 'Gasto operativo', en: 'Operating expense' }), k.opex],
      [
        L({ es: 'Gastos (costo directo + operativo)', en: 'Expenses (direct + operating)' }),
        gastos,
      ],
      [L({ es: 'Otros', en: 'Other' }), k.other],
      [L({ es: 'Utilidad bruta', en: 'Gross profit' }), k.grossProfit],
      // El margen va como fracción para que Excel lo pueda formatear como porcentaje y
      // seguir operándolo. `null` cuando no hubo ventas: una celda vacía dice "no
      // aplica"; un 0 diría "margen cero", que es una afirmación distinta y falsa.
      [
        L({ es: 'Margen bruto', en: 'Gross margin' }),
        k.grossMarginPct === null ? null : k.grossMarginPct / 100,
      ],
      [L({ es: 'Por cobrar abierto', en: 'Open receivables' }), k.accountsReceivableOpen],
      [L({ es: 'Por pagar abierto', en: 'Open payables' }), k.accountsPayableOpen],
    );
  } else {
    resumen.push([
      L({
        es: 'Este reporte no incluyó la sección de indicadores.',
        en: 'This report did not include the indicators section.',
      }),
    ]);
  }

  const wsResumen = XLSX.utils.aoa_to_sheet(resumen);
  wsResumen['!cols'] = [{ wch: 38 }, { wch: 22 }];
  XLSX.utils.book_append_sheet(wb, wsResumen, L({ es: 'Resumen', en: 'Summary' }));

  if (data.revenueTrend) {
    const filas: (string | number)[][] = [
      [
        L({ es: 'Fecha', en: 'Date' }),
        L({ es: 'Ingresos', en: 'Revenue' }),
        L({ es: 'Costo directo', en: 'Direct cost' }),
        L({ es: 'Gasto operativo', en: 'Operating expense' }),
        L({ es: 'Otros', en: 'Other' }),
      ],
      ...data.revenueTrend.series.map((p) => [p.date, p.revenue, p.cogs, p.opex, p.other]),
    ];
    XLSX.utils.book_append_sheet(
      wb,
      XLSX.utils.aoa_to_sheet(filas),
      L({ es: 'Evolución', en: 'Trend' }),
    );
  }

  if (data.costBreakdown) {
    const filas: (string | number)[][] = [
      [
        L({ es: 'Categoría', en: 'Category' }),
        L({ es: 'Tipo', en: 'Type' }),
        L({ es: 'Total', en: 'Total' }),
        L({ es: 'Movimientos', en: 'Entries' }),
        L({ es: 'Participación', en: 'Share' }),
      ],
      ...data.costBreakdown.map((c) => [
        c.category,
        c.type,
        c.total,
        c.transactionCount,
        c.sharePct / 100,
      ]),
    ];
    XLSX.utils.book_append_sheet(
      wb,
      XLSX.utils.aoa_to_sheet(filas),
      L({ es: 'Costos', en: 'Costs' }),
    );
  }

  if (data.topProducts) {
    const filas: (string | number | null)[][] = [
      [
        L({ es: 'Producto', en: 'Product' }),
        L({ es: 'Familia', en: 'Family' }),
        L({ es: 'Ingreso', en: 'Revenue' }),
        L({ es: 'Costo', en: 'Cost' }),
        L({ es: 'Utilidad bruta', en: 'Gross profit' }),
        L({ es: 'Margen', en: 'Margin' }),
        L({ es: 'Unidades', en: 'Units' }),
      ],
      ...data.topProducts.map((p) => [
        p.name,
        p.category,
        p.revenue,
        p.cogs,
        p.grossProfit,
        p.grossMarginPct === null ? null : p.grossMarginPct / 100,
        p.units,
      ]),
    ];
    XLSX.utils.book_append_sheet(
      wb,
      XLSX.utils.aoa_to_sheet(filas),
      L({ es: 'Productos', en: 'Products' }),
    );
  }

  if (data.risks) {
    const r = data.risks;
    const filas: (string | number)[][] = [
      [
        L({ es: 'Alerta', en: 'Alert' }),
        L({ es: 'Valor', en: 'Value' }),
        L({ es: 'Umbral', en: 'Threshold' }),
        L({ es: 'Unidad', en: 'Unit' }),
        L({ es: 'Fecha', en: 'Date' }),
      ],
      ...r.alerts.map((a) => [
        a.label,
        a.triggeredValue,
        a.threshold,
        a.unit,
        a.occurredAt.slice(0, 10),
      ]),
      [],
      [
        `${L({ es: 'Antigüedad al', en: 'Ageing as of' })} ${r.agingAsOf}`,
        L({ es: 'Por cobrar', en: 'Receivable' }),
        L({ es: 'Por pagar', en: 'Payable' }),
      ],
      ...Object.keys(r.arAging).map((b) => [
        b,
        r.arAging[b as keyof typeof r.arAging],
        r.apAging[b as keyof typeof r.apAging],
      ]),
    ];
    XLSX.utils.book_append_sheet(
      wb,
      XLSX.utils.aoa_to_sheet(filas),
      L({ es: 'Riesgos', en: 'Risks' }),
    );
  }

  const wsNarrativa = XLSX.utils.aoa_to_sheet([
    [L({ es: 'Análisis', en: 'Analysis' })],
    ...input.narrative.split('\n').map((linea) => [linea]),
  ]);
  wsNarrativa['!cols'] = [{ wch: 120 }];
  XLSX.utils.book_append_sheet(wb, wsNarrativa, L({ es: 'Análisis', en: 'Analysis' }));

  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}
