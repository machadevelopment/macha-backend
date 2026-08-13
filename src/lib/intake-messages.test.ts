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

describe('resubir un archivo sin nada nuevo NO es un archivo ilegible', () => {
  /*
   * Encontrado corriendo el flujo completo sobre un archivo real (2026-08-12): la segunda
   * subida del mismo .xlsx terminaba en `unsupported` con "no pudimos leer movimientos
   * financieros en este archivo, descarga la plantilla".
   *
   * Era el caso de ÉXITO de la deduplicación —cero filas al modelo, costo USD 0— presentado
   * al cliente como un fracaso suyo. La rama de "cero filas" es anterior a la huella por
   * fila, cuando cero filas solo podía significar archivo ilegible.
   *
   * Ningún test unitario podía verlo: hace falta una primera subida para que la segunda
   * deduplique.
   */
  test('el mensaje da una buena noticia y no pide ninguna acción', () => {
    for (const locale of ['es', 'en'] as const) {
      const m = INTAKE_MESSAGES[locale].nothingNew(1167);
      // No culpa al cliente ni lo manda a descargar nada: no hay nada que corregir.
      expect(m.toLowerCase()).not.toContain('plantilla');
      expect(m.toLowerCase()).not.toContain('template');
      // El separador de miles depende del idioma, y en español los números de CUATRO
      // cifras no lo llevan ("1167" en es, "1,167" en en). Se afirma que el conteo
      // aparece, no una forma concreta — que es lo que de verdad importa.
      expect(m.replace(/[.,]/g, '')).toContain('1167');
    }
  });

  test('el texto de archivo ilegible sigue siendo distinto', () => {
    // Los dos desenlaces llegan a "cero filas" y tienen que leerse como cosas opuestas.
    expect(INTAKE_MESSAGES.es.nothingNew(10)).not.toBe(INTAKE_MESSAGES.es.unsupportedContent(null));
  });
});
