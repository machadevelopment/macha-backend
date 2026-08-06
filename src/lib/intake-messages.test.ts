import { describe, expect, test } from 'bun:test';
import { INTAKE_MESSAGES, summarizeUnusableReasons } from './intake-messages';

describe('summarizeUnusableReasons', () => {
  test('deduplica: un libro de doce hojas de notas no produce doce veces la misma frase', () => {
    const repetida = Array(12).fill('La hoja tiene notas sueltas, no movimientos.');
    expect(summarizeUnusableReasons(repetida)).toBe('La hoja tiene notas sueltas, no movimientos.');
  });

  test('corta en dos razones para que el mensaje siga siendo legible', () => {
    const resumen = summarizeUnusableReasons(['Primera.', 'Segunda.', 'Tercera.', 'Cuarta.']);
    expect(resumen).toBe('Primera. Segunda.');
    expect(resumen).not.toContain('Tercera');
  });

  test('sin razones devuelve null, no una cadena vacía', () => {
    // El mensaje al cliente distingue los dos casos: con `null` cierra la primera
    // oración con punto en vez de dejar un ": " colgando.
    expect(summarizeUnusableReasons([])).toBeNull();
    expect(summarizeUnusableReasons(['', '   '])).toBeNull();
  });
});

describe('unsupportedContent', () => {
  for (const locale of ['es', 'en'] as const) {
    test(`${locale}: apunta a la plantilla, que es la única acción que sirve`, () => {
      // Reintentar el mismo archivo da el mismo resultado, así que el texto no puede
      // sugerirlo — a diferencia de `failed`, que sí es reintentable.
      const msg = INTAKE_MESSAGES[locale].unsupportedContent('Parece una hoja de notas.');
      expect(msg.toLowerCase()).toContain(locale === 'es' ? 'plantilla' : 'template');
      expect(msg).toContain('Parece una hoja de notas.');
    });

    test(`${locale}: sin razón del modelo, la frase sigue cerrando bien`, () => {
      const msg = INTAKE_MESSAGES[locale].unsupportedContent(null);
      expect(msg).not.toContain(': ');
      expect(msg).not.toContain('null');
    });
  }
});
