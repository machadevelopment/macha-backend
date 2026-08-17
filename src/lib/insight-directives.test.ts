import { describe, expect, test } from 'bun:test';
import { directivaDeEscritura, directivaDeIdioma, simboloDeMoneda } from '@/lib/insight-directives';
import { DEFAULT_INSIGHT_PROMPT } from '@/lib/anthropic';

/**
 * CU-868krvtjw — el "Generate Insight" con símbolo de moneda y sin decimales.
 *
 * Los insights salían con cifras como `12345.67` sueltas en la frase: sin decir de qué
 * moneda hablan y con dos decimales que a un dueño de PYME no le dicen nada.
 */

describe('símbolo de moneda', () => {
  test('las dos monedas que el producto soporta', () => {
    expect(simboloDeMoneda('GTQ')).toBe('Q');
    expect(simboloDeMoneda('USD')).toBe('$');
  });

  test('una moneda desconocida cae al CÓDIGO, no a un símbolo inventado', () => {
    // Feo pero correcto: "EUR 1,200" se entiende. Inventar un símbolo para una moneda que
    // no conocemos sería afirmar algo sobre el dinero del cliente sin base.
    expect(simboloDeMoneda('EUR')).toBe('EUR');
  });
});

describe('directiva de escritura', () => {
  test('nombra el símbolo Y el código de la moneda de la empresa', () => {
    // Los dos: el símbolo es lo que tiene que escribir, el código es lo que le dice de qué
    // moneda son las cifras del snapshot. Con uno solo el modelo tendría que inferir el otro.
    const d = directivaDeEscritura({ locale: 'es', baseCurrency: 'GTQ' });
    expect(d).toContain('Q');
    expect(d).toContain('GTQ');
  });

  test('una empresa en dólares NO recibe la instrucción de quetzales', () => {
    /*
     * El fallo silencioso que este test previene: si el símbolo estuviera quemado, una
     * empresa con `baseCurrency: 'USD'` recibiría sus cifras rotuladas con Q. El número
     * sería correcto y la moneda mentira — el peor tipo de error en este producto, porque
     * se ve perfectamente normal.
     */
    const d = directivaDeEscritura({ locale: 'es', baseCurrency: 'USD' });
    expect(d).toContain('$');
    expect(d).toContain('USD');
    expect(d).not.toContain('GTQ');
  });

  test('prohíbe los decimales de forma explícita, con ejemplo', () => {
    // "sin decimales" a secas es ambiguo para un modelo; el par ejemplo-bueno /
    // ejemplo-malo es lo que de verdad fija el formato.
    const d = directivaDeEscritura({ locale: 'es', baseCurrency: 'GTQ' });
    expect(d).toMatch(/SIN decimales/);
    expect(d).toContain('12450.35');
  });

  test('en inglés dice lo mismo, no un subconjunto', () => {
    const es = directivaDeEscritura({ locale: 'es', baseCurrency: 'GTQ' });
    const en = directivaDeEscritura({ locale: 'en', baseCurrency: 'GTQ' });

    // Las dos versiones tienen que cubrir las tres reglas: moneda, decimales y claridad.
    for (const d of [es, en]) {
      expect(d).toContain('Q');
      expect(d).toContain('12450.35');
      expect(d.length).toBeGreaterThan(150);
    }
    expect(en).not.toBe(es);
  });

  test('va en el idioma del contenido, no siempre en español', () => {
    // Mezclar idiomas en el mismo bloque de sistema es justo lo que hace que un modelo
    // devuelva media respuesta en el idioma equivocado.
    const en = directivaDeEscritura({ locale: 'en', baseCurrency: 'USD' });
    expect(en).toContain('Amounts are in');
    expect(en).not.toContain('Los montos');
  });
});

describe('la directiva NO depende del prompt editable', () => {
  test('el prompt por defecto no dice nada de moneda ni de decimales', () => {
    /*
     * ═══ POR QUÉ ESTE TEST ═══
     *
     * El prompt de insights es EDITABLE por un super_admin (`platform_settings`).
     * `DEFAULT_INSIGHT_PROMPT` es solo el respaldo para entornos que todavía no tienen la
     * fila, así que una regla escrita ahí NO llega a una instalación que ya guardó su
     * prompt — es decir, no llega a producción.
     *
     * Este test falla si alguien "simplifica" moviendo la regla al prompt por defecto: se
     * vería más limpio y dejaría de funcionar donde importa, en silencio.
     */
    expect(DEFAULT_INSIGHT_PROMPT).not.toContain('decimales');
    expect(DEFAULT_INSIGHT_PROMPT).not.toContain('símbolo');
  });

  test('idioma y escritura son directivas separadas del template', () => {
    // Las dos se anexan DESPUÉS del template del admin, y por eso valen sin importar lo que
    // ese admin haya escrito.
    expect(directivaDeIdioma('es')).toBe('Responde en español.');
    expect(directivaDeIdioma('en')).toBe('Respond in English.');
  });
});
