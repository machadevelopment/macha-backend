/**
 * Cómo tiene que ESCRIBIR el modelo cuando genera los insights del dashboard.
 *
 * ═══ EL BUG (CU-868krvtjw) ═══
 *
 * Macha pidió que el "Generate Insight" saliera más claro, **con símbolo de moneda y
 * números sin decimales**. Los insights salían con cifras como `12345.67` sueltas en la
 * frase: sin saber de qué moneda hablan y con dos decimales que a un dueño de PYME no le
 * dicen nada.
 *
 * Y la causa de fondo no era solo que nadie se lo hubiera pedido: **el snapshot que recibe
 * el modelo no llevaba la moneda**. Son tres meses de números crudos por tipo de
 * movimiento, sin un solo campo que diga si son quetzales o dólares. Aunque el prompt
 * hubiera pedido el símbolo, el modelo habría tenido que adivinarlo — y adivinar la moneda
 * de las cifras de una empresa es exactamente la clase de error que este producto no puede
 * permitirse. Por eso la moneda ahora viaja en el snapshot Y se nombra en la directiva.
 *
 * ═══ POR QUÉ NO VA EN `DEFAULT_INSIGHT_PROMPT` ═══
 *
 * Porque no llegaría a producción. El prompt de insights es **editable por un super_admin**
 * (`platform_settings`, CU-868kfvafy): `DEFAULT_INSIGHT_PROMPT` es solo el respaldo para
 * entornos que todavía no tienen la fila. Escribir la regla ahí la dejaría sin efecto en
 * toda instalación que ya haya guardado su prompt — es decir, en la única que importa.
 *
 * Es la misma trampa que ya documenta `EMIT_INSIGHTS_TOOL` en `lib/anthropic.ts` sobre por
 * qué la clasificación se pide por el esquema de la herramienta y no por el texto, y el
 * mismo camino que tomó la instrucción de IDIOMA en `modules/insights/index.ts`: se agrega
 * DESPUÉS del template, así vale sin importar lo que el admin haya escrito.
 *
 * ═══ QUÉ SE PIDE, Y QUÉ NO ═══
 *
 * Se piden reglas de ESCRITURA, no de cálculo. La regla no-negociable sigue intacta: el
 * modelo narra, nunca calcula. Redondear a enteros al escribir no es recalcular — es elegir
 * cómo se presenta un número que ya vino dado, igual que hace `formatMoney` en el frontend
 * con todas las demás cifras del producto.
 */

/** Símbolo por moneda base. Es el mismo par que soporta el resto del producto. */
const SIMBOLO: Record<string, string> = { GTQ: 'Q', USD: '$' };

export function simboloDeMoneda(baseCurrency: string): string {
  // Si algún día entra una moneda nueva sin símbolo conocido, se usa el CÓDIGO. Es feo pero
  // es correcto; inventar un símbolo sería peor que mostrar "GTQ 1,200".
  return SIMBOLO[baseCurrency] ?? baseCurrency;
}

/**
 * La directiva que se anexa al prompt del admin.
 *
 * En el idioma del contenido, no siempre en español: es una instrucción sobre CÓMO escribir
 * el texto que el usuario va a leer, y mezclar idiomas en el mismo bloque de sistema es
 * justo lo que hace que un modelo devuelva media respuesta en el idioma equivocado.
 */
export function directivaDeEscritura(params: {
  locale: 'es' | 'en';
  baseCurrency: string;
}): string {
  const simbolo = simboloDeMoneda(params.baseCurrency);

  if (params.locale === 'en') {
    return [
      `Amounts are in ${params.baseCurrency}. Always write them with the ${simbolo} symbol and rounded to whole numbers, with thousands separators and NO decimals — "${simbolo}12,450", never "12450.35".`,
      'Lead with the finding, not with a description of the data. One or two sentences per insight, no preamble.',
      'Each insight must name something the owner can DO, not only what happened.',
    ].join(' ');
  }

  return [
    `Los montos están en ${params.baseCurrency}. Escríbelos SIEMPRE con el símbolo ${simbolo} y redondeados a números enteros, con separador de miles y SIN decimales — "${simbolo}12,450", nunca "12450.35".`,
    'Empieza por el hallazgo, no por describir los datos. Una o dos frases por insight, sin preámbulo.',
    'Cada insight tiene que nombrar algo que el dueño pueda HACER, no solo lo que pasó.',
  ].join(' ');
}

/** Instrucción de idioma. Estaba en línea en el módulo; vive acá junto a la de escritura. */
export function directivaDeIdioma(locale: 'es' | 'en'): string {
  return locale === 'en' ? 'Respond in English.' : 'Responde en español.';
}
