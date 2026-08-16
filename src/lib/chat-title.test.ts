import { describe, expect, test } from 'bun:test';
import { esTituloPorDefecto, tituloDesdePrimerMensaje, tituloPorDefecto } from './chat-title';

describe('tituloDesdePrimerMensaje', () => {
  test('una pregunta corta se usa tal cual', () => {
    expect(tituloDesdePrimerMensaje('¿Por qué bajó mi margen en julio?')).toBe(
      '¿Por qué bajó mi margen en julio?',
    );
  });

  test('colapsa saltos de línea y espacios repetidos', () => {
    // Un mensaje pegado desde otro lado trae saltos. Contarlos al medir daría un título
    // más corto de lo que parece, y dejarlos dentro descuadra la fila de la lista.
    expect(tituloDesdePrimerMensaje('¿Cuánto\n\nvendí   ayer?')).toBe('¿Cuánto vendí ayer?');
  });

  test('un mensaje largo se corta en el último espacio, no a mitad de palabra', () => {
    const largo =
      '¿Cuánto gasté en proveedores durante el primer trimestre del año pasado comparado con este?';
    const titulo = tituloDesdePrimerMensaje(largo)!;

    expect(titulo.endsWith('…')).toBe(true);
    // El corte respeta la palabra: el título sin los puntos suspensivos es un prefijo del
    // mensaje que termina donde terminaba una palabra.
    const sinPuntos = titulo.slice(0, -1);
    expect(largo.startsWith(sinPuntos)).toBe(true);
    expect(largo[sinPuntos.length]).toBe(' ');
  });

  test('una sola palabra larguísima se corta duro en vez de quedar vacía', () => {
    // Una URL o un id pegados: no hay espacio donde cortar, y respetar la palabra dejaría
    // un título vacío.
    const url = `https://example.com/${'a'.repeat(200)}`;
    const titulo = tituloDesdePrimerMensaje(url)!;
    expect(titulo.length).toBeGreaterThan(20);
    expect(titulo.endsWith('…')).toBe(true);
  });

  test('no deja puntuación colgando antes de los puntos suspensivos', () => {
    const mensaje =
      'Revisá mis ventas de enero, febrero, marzo, y decime qué producto cayó más rápido';
    const titulo = tituloDesdePrimerMensaje(mensaje)!;
    expect(titulo).not.toMatch(/[,;:.\s]…$/);
  });

  test('un mensaje sin contenido usable devuelve null', () => {
    // null = "dejá el marcador". Una cadena vacía en la lista dejaría una fila que no se
    // puede ni clicar con confianza.
    expect(tituloDesdePrimerMensaje('   ')).toBeNull();
    expect(tituloDesdePrimerMensaje('\n\n')).toBeNull();
    expect(tituloDesdePrimerMensaje('')).toBeNull();
  });
});

describe('esTituloPorDefecto', () => {
  test('reconoce los marcadores de los dos idiomas', () => {
    expect(esTituloPorDefecto('Nuevo chat')).toBe(true);
    expect(esTituloPorDefecto('New chat')).toBe(true);
    // Los chats que ya existen en producción se crearon TODOS con 'Nuevo chat', incluidos
    // los de empresas en inglés. Por eso la lista lleva los dos y no solo el del locale.
  });

  test('tolera espacios y mayúsculas', () => {
    expect(esTituloPorDefecto('  nuevo chat  ')).toBe(true);
  });

  test('un título puesto por el usuario NO es por defecto', () => {
    // La condición que impide pisar lo que el usuario escribió, o el nombre con el que se
    // abre un hilo desde un reporte.
    expect(esTituloPorDefecto('Cierre de julio')).toBe(false);
    expect(esTituloPorDefecto('Nuevo chat con el contador')).toBe(false);
  });
});

describe('tituloPorDefecto', () => {
  test('sigue el idioma de la empresa', () => {
    expect(tituloPorDefecto('en')).toBe('New chat');
    expect(tituloPorDefecto('es')).toBe('Nuevo chat');
  });

  test('un locale desconocido cae a español, no a vacío', () => {
    expect(tituloPorDefecto('pt')).toBe('Nuevo chat');
  });

  test('todo lo que produce lo reconoce esTituloPorDefecto', () => {
    // Si alguien agrega un idioma acá y olvida la lista de la otra función, los chats de
    // ese idioma dejarían de auto-titularse en silencio.
    for (const locale of ['es', 'en']) {
      expect(esTituloPorDefecto(tituloPorDefecto(locale))).toBe(true);
    }
  });
});
