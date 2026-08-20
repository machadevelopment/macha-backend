import type { ReportSection, ReportType } from '@/lib/report-sections';
import { directivaDeEmpresa, directivaDeEscritura } from '@/lib/insight-directives';

/**
 * Construcción del prompt de la narrativa de un reporte, en función de las SECCIONES
 * pedidas.
 *
 * El eje del ticket B2 es que el conjunto de secciones module también qué se le pide a la
 * IA, no solo qué se calcula. Sin esto, un reporte de solo KPIs recibiría igual la
 * instrucción genérica y el modelo narraría —o peor, inventaría— productos y categorías
 * que no vienen en el snapshot.
 *
 * Vive aquí y no en `lib/anthropic.ts` por la misma razón que `DEFAULT_INSIGHT_PROMPT`
 * está donde está: `anthropic.ts` es el cliente de Claude y no debe saber de secciones de
 * reporte. Recibe el prompt ya armado.
 */

/** Tope de las instrucciones libres del usuario. Ver `sanitizeInstructions`. */
export const MAX_INSTRUCTIONS_LENGTH = 500;

const SECTION_DIRECTIVES: Record<ReportSection, { es: string; en: string }> = {
  kpis: {
    es: 'Comenta los indicadores del período (ingresos, costo directo, gasto operativo, utilidad y margen bruto, cuentas por cobrar y por pagar abiertas) que vienen en "kpis".',
    en: 'Comment on the period indicators (revenue, direct cost, operating expense, gross profit and margin, open receivables and payables) provided under "kpis".',
  },
  revenue_trend: {
    es: 'Describe la evolución de ingresos usando "revenueTrend": compara el período con la ventana anterior de igual duración y señala el movimiento de la serie diaria. No extrapoles fuera del rango.',
    en: 'Describe the revenue trajectory using "revenueTrend": compare the period against the previous window of equal length and point out the daily series movement. Do not extrapolate beyond the range.',
  },
  cost_breakdown: {
    es: 'Explica en qué se fue el dinero a partir de "costBreakdown" (categorías de costo directo y gasto operativo, con su participación dentro de su propio tipo). Nombra las categorías tal como vienen.',
    en: 'Explain where the money went using "costBreakdown" (direct-cost and operating-expense categories with their share within their own type). Name the categories exactly as given.',
  },
  top_products: {
    es: 'Comenta los productos de "topProducts" (ingreso, margen y tendencia contra la ventana anterior). Si la lista viene vacía significa que la ingesta no identificó productos en el rango: dilo así, no lo llenes con suposiciones.',
    en: 'Comment on the products in "topProducts" (revenue, margin and trend vs. the previous window). An empty list means ingestion identified no products in the range: say exactly that, do not fill the gap with guesses.',
  },
  risks: {
    es: 'Resume los riesgos de "risks": las alertas que ya dispararon en el período y la antigüedad de las cuentas por cobrar y por pagar. Ojo: la antigüedad está medida al día "agingAsOf", no al cierre del período; si no coinciden, dilo.',
    en: 'Summarize the risks in "risks": alerts that already fired during the period plus receivable/payable ageing. Note: ageing is measured as of "agingAsOf", not at period close; if they differ, say so.',
  },
  recommendations: {
    es: 'Cierra con 2 o 3 recomendaciones accionables y concretas para el dueño de la empresa, derivadas ÚNICAMENTE de las cifras del snapshot.',
    en: 'Close with 2-3 concrete, actionable recommendations for the business owner, derived ONLY from the snapshot figures.',
  },
};

const BASE: Record<'es' | 'en', string> = {
  es: `Eres el asistente financiero de Macha Finance. Recibes las métricas EXACTAS (ya calculadas por SQL) de un reporte ejecutivo de una PYME.
NUNCA inventes, recalcules ni completes cifras: usa solo las del snapshot. Si una sección viene vacía, dilo explícitamente en vez de rellenarla.
Escribe una narrativa ejecutiva en texto plano, sin markdown, en español.`,
  en: `You are Macha Finance's financial assistant. You receive the EXACT metrics (already computed via SQL) for an SME's executive report.
NEVER invent, recompute or fill in figures: use only the snapshot's. If a section comes back empty, say so explicitly instead of padding it.
Write an executive narrative in plain text, no markdown, in English.`,
};

/*
 * CU-868ku9rpy: cada tipo dice al modelo QUÉ PREGUNTA responde, no solo cómo llamarse.
 *
 * Sin esto, cuatro tipos con las mismas secciones producirían cuatro narrativas
 * indistinguibles y el selector de tipo sería decorativo. La intro es lo que hace que
 * "análisis de costos" hable de costos aunque comparta la sección de KPIs con los otros
 * tres.
 */
const TYPE_INTRO: Record<ReportType, { es: string; en: string }> = {
  executive_summary: {
    es: 'El reporte es un RESUMEN EJECUTIVO: qué pasó en el período y por qué importa, en el orden en que se listan las secciones.',
    en: 'The report is an EXECUTIVE SUMMARY: what happened in the period and why it matters, in the order the sections are listed.',
  },
  financial_performance: {
    es: 'El reporte es un ANÁLISIS DE DESEMPEÑO FINANCIERO: cómo se movieron ingresos, costos y margen contra el período anterior, y qué explica la diferencia. Prioriza la comparación por encima de la foto del período.',
    en: 'The report is a FINANCIAL PERFORMANCE review: how revenue, costs and margin moved against the previous period, and what explains the gap. Favour the comparison over the snapshot.',
  },
  cost_analysis: {
    es: 'El reporte es un ANÁLISIS DE COSTOS Y GASTOS: en qué se está yendo el dinero, qué categorías pesan más y cuáles se movieron. Habla de los ingresos solo como referencia para pesar el gasto, no como tema.',
    en: 'The report is a COST AND SPEND analysis: where the money goes, which categories weigh most and which ones moved. Mention revenue only as a yardstick for the spend, not as the subject.',
  },
  sales_performance: {
    es: 'El reporte es un ANÁLISIS DE VENTAS Y PRODUCTOS: qué se vendió, qué producto manda y cómo se movió la venta en el período. Si la sección de productos viene vacía, dilo — significa que el archivo del cliente no traía producto por fila.',
    en: 'The report is a SALES AND PRODUCT analysis: what sold, which product leads and how sales moved over the period. If the products section is empty, say so — it means the client file had no product per row.',
  },
};

/**
 * Limpia las instrucciones libres del usuario antes de meterlas en el prompt.
 *
 * No es una defensa contra "prompt injection" en el sentido clásico y no se vende como
 * tal: el modelo no tiene herramientas ni acceso a datos en esta llamada —recibe un
 * snapshot ya calculado de UNA empresa y devuelve texto—, así que el peor caso de una
 * instrucción hostil es una narrativa mal escrita sobre los propios datos de quien la
 * escribió. Lo que sí hace falta, y es lo que hace esto:
 *
 *  - un TOPE de longitud, para que un campo de texto libre no se vuelva una vía de gasto
 *    de tokens sin límite (cada llamada se cobra en créditos, pero el costo real en el
 *    proveedor no lo acota el crédito);
 *  - quitar saltos de línea repetidos y caracteres de control, que es como se intenta
 *    fabricar un separador falso que parezca el fin del bloque de instrucciones.
 */
export function sanitizeInstructions(raw: string): string {
  return (
    raw
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ')
      .replace(/\r\n?/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
      .slice(0, MAX_INSTRUCTIONS_LENGTH)
  );
}

export function buildReportSystemPrompt(params: {
  locale: 'es' | 'en';
  reportType: ReportType;
  sections: ReportSection[];
  instructions?: string | null;
  /**
   * CU-868kt4ap8: la moneda de la empresa.
   *
   * Macha reportó que "en el resumen ejecutivo no sale el tipo de moneda ni el número bien
   * formateado". El RENDER sí formatea —`report-render.ts` pasa todo por `formatMoney` con
   * la moneda base—, pero la NARRATIVA la escribe el modelo, y el snapshot que recibe son
   * números pelados: ni un campo dice si son quetzales o dólares.
   *
   * Es exactamente el mismo hueco que CU-868krvtjw encontró en los insights, y se cierra
   * con la misma directiva. Opcional para no romper a los llamadores que no la pasan —hoy
   * solo los tests—, y en ese caso el prompt queda como estaba.
   */
  baseCurrency?: string;
  /**
   * CU-868kt984z: el nombre de la empresa del cliente. Sin él, el único nombre propio en
   * todo el contexto era "Macha Finance" y el modelo lo usaba como sujeto de la narrativa.
   * Opcional para no romper a los llamadores que no lo pasan (hoy solo los tests).
   */
  companyName?: string | null;
}): string {
  const { locale, reportType, sections } = params;
  const partes = [BASE[locale], TYPE_INTRO[reportType][locale]];

  const directivas = sections.map((s, i) => `${i + 1}. ${SECTION_DIRECTIVES[s][locale]}`);
  partes.push(
    locale === 'es'
      ? `Cubre EXACTAMENTE estas secciones, en este orden, y ninguna más:\n${directivas.join('\n')}`
      : `Cover EXACTLY these sections, in this order, and no others:\n${directivas.join('\n')}`,
  );

  // La directiva de escritura va ANTES de las instrucciones del usuario y DESPUÉS de las
  // secciones: es una regla de formato de la casa, no una preferencia negociable. El
  // usuario puede pedir en qué poner el acento; no puede pedir cifras sin moneda.
  if (params.baseCurrency) {
    partes.push(directivaDeEscritura({ locale, baseCurrency: params.baseCurrency }));
  }

  // Quién es el sujeto de la narrativa. Va junto a la directiva de escritura y antes de
  // las instrucciones del usuario por la misma razón: es regla de la casa. Un usuario
  // puede pedir en qué poner el acento; no puede renombrar a su propia empresa.
  const empresa = directivaDeEmpresa({ locale, companyName: params.companyName });
  if (empresa) partes.push(empresa);

  const limpias = params.instructions ? sanitizeInstructions(params.instructions) : '';
  if (limpias) {
    // Delimitado y etiquetado como preferencia de ENFOQUE/TONO: lo que el usuario puede
    // pedir es sobre qué poner el acento, no que se cambien las cifras ni que se agreguen
    // secciones que no se calcularon (para eso están las secciones, que además sí
    // determinan qué datos viajan en el snapshot).
    partes.push(
      locale === 'es'
        ? `El usuario pidió este enfoque para la narrativa. Respétalo mientras no contradiga las reglas de arriba; NO cambia las cifras, NO agrega secciones y NO autoriza inventar datos:\n<<<\n${limpias}\n>>>`
        : `The user asked for this narrative focus. Honor it as long as it does not contradict the rules above; it does NOT change any figure, does NOT add sections and does NOT authorize inventing data:\n<<<\n${limpias}\n>>>`,
    );

    /*
     * CU-868kt96fw — SI LO QUE PIDIÓ NO ESTÁ EN EL SNAPSHOT, HAY QUE DECÍRSELO.
     *
     * Macha reportó que "el reporte ignora por completo el campo de instrucciones". El
     * ticket mandaba a buscar dónde se pierde el texto entre el formulario y el prompt.
     * NO SE PIERDE EN NINGÚN LADO: se revisaron los payloads reales de pg-boss en
     * producción y las cuatro instrucciones que se escribieron llegaron enteras.
     *
     * Lo que pasó es otra cosa, y las cuatro coinciden:
     *
     *   "Incluye ventas por producto"                          → secciones ["kpis"]
     *   "…por producto con costo y venta total por producto"   → secciones ["kpis"]
     *   "sales by product this month"                          → ["kpis","recommendations"]
     *   "Agrega una gráfica de mis ventas por mes…"            → ["kpis","recommendations"]
     *
     * Las cuatro piden datos POR PRODUCTO, y en las cuatro la sección `top_products`
     * estaba sin marcar — así que el snapshot no traía un solo producto. El modelo hizo
     * exactamente lo correcto: la regla no-negociable es no inventar, y no inventó.
     *
     * El defecto real es que se calló. Desde el lado del usuario, "pedí ventas por
     * producto y el reporte no las trae" es indistinguible de "el campo no funciona" — y
     * eso es literalmente lo que reportó.
     *
     * Es el mismo criterio que ya aplica `toolSalesByStore` en el chat: distinguir "ese
     * dato no está" de "no puedo consultarlo" es lo que convierte una respuesta inútil en
     * una accionable. Acá además el usuario puede arreglarlo solo, marcando la sección.
     */
    partes.push(
      locale === 'es'
        ? 'Si lo que pidió el usuario necesita datos que NO vienen en el snapshot, NO lo ignores en silencio: cierra la narrativa con una línea que diga qué pidió, que ese dato no está en este reporte y qué sección tendría que agregar para obtenerlo. Nunca lo omitas sin más.'
        : "If the user's request needs data that is NOT in the snapshot, do NOT silently ignore it: close the narrative with one line stating what they asked for, that the data is not in this report, and which section they would need to add to get it. Never just leave it out.",
    );
  }

  return partes.join('\n\n');
}
