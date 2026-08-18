import { describe, expect, test } from 'bun:test';
import { directivaDeEmpresa } from '@/lib/insight-directives';
import { buildReportSystemPrompt } from '@/lib/report-prompt';

/**
 * CU-868kt984z — LA NARRATIVA NOMBRA A LA EMPRESA DEL CLIENTE, NO A LA PLATAFORMA.
 *
 * Macha abrió un reporte y leyó "Durante julio, Macha Finance registró ingresos por
 * 1,638.41…". El ticket apuntaba a un literal en la plantilla; no era eso. El prompt abre
 * con "Eres el asistente financiero de Macha Finance" y el snapshot que sigue son cifras
 * sin dueño: el modelo necesitaba un sujeto y usó el único nombre propio disponible.
 *
 * Por eso lo que se fija acá NO es la ausencia de "Macha Finance" —esa frase tiene que
 * seguir, es la identidad del asistente— sino que junto a ella viaje el nombre real y la
 * prohibición explícita de confundirlos.
 */
describe('directivaDeEmpresa', () => {
  test('nombra a la empresa y prohíbe el nombre de la plataforma', () => {
    const d = directivaDeEmpresa({ locale: 'es', companyName: 'Electro Hogar' })!;
    expect(d).toContain('Electro Hogar');
    expect(d).toContain('NUNCA');
    expect(d).toContain('Macha Finance');
  });

  test('en inglés dice lo mismo, en inglés', () => {
    const d = directivaDeEmpresa({ locale: 'en', companyName: 'Electro Hogar' })!;
    expect(d).toContain('Electro Hogar');
    expect(d).toContain('NEVER');
    // Ni una palabra en español: mezclar idiomas en el bloque de sistema es justo lo que
    // hace que un modelo devuelva media respuesta en el idioma equivocado.
    expect(d).not.toContain('empresa');
  });

  test('sin nombre NO emite directiva, en vez de pedir que la llamen ""', () => {
    // Emitirla vacía es peor que el bug: la narrativa arrancaría con comillas vacías
    // donde debería ir un nombre.
    expect(directivaDeEmpresa({ locale: 'es', companyName: null })).toBeNull();
    expect(directivaDeEmpresa({ locale: 'es', companyName: undefined })).toBeNull();
    expect(directivaDeEmpresa({ locale: 'es', companyName: '   ' })).toBeNull();
  });

  test('el nombre se recorta pero se respeta tal cual lo escribió el cliente', () => {
    // Nada de title-case ni de quitarle el "S.A.": el nombre legal es el nombre legal.
    const d = directivaDeEmpresa({ locale: 'es', companyName: '  distribuidora LA UNIÓN, S.A. ' })!;
    expect(d).toContain('"distribuidora LA UNIÓN, S.A."');
  });
});

describe('el prompt del reporte lleva el nombre de la empresa', () => {
  const base = { locale: 'es' as const, reportType: 'executive_summary' as const, sections: [] };

  test('con nombre, la instrucción está en el prompt final', () => {
    const prompt = buildReportSystemPrompt({ ...base, companyName: 'Electro Hogar' });
    expect(prompt).toContain('Electro Hogar');
    expect(prompt).toContain('NUNCA llames "Macha Finance"');
  });

  test('la identidad del asistente NO se borra', () => {
    // La corrección no es quitar "Macha Finance" del prompt: eso deja al modelo sin sujeto
    // y elegirá otro. Es darle el correcto y decirle cuál no es.
    const prompt = buildReportSystemPrompt({ ...base, companyName: 'Electro Hogar' });
    expect(prompt).toContain('Eres el asistente financiero de Macha Finance');
  });

  test('sin nombre el prompt queda como estaba (los llamadores viejos no se rompen)', () => {
    const prompt = buildReportSystemPrompt(base);
    expect(prompt).not.toContain('La empresa sobre la que escribes');
  });

  test('el nombre va ANTES de las instrucciones libres del usuario', () => {
    // Mismo lugar que la directiva de moneda, y por la misma razón: son reglas de la casa.
    // El bloque del usuario va después, delimitado con <<< >>> y etiquetado como
    // PREFERENCIA — el prompt dice explícitamente que no cambia cifras ni agrega secciones.
    // Meter el nombre de la empresa dentro o después de ese bloque lo volvería negociable:
    // "llámame Acme" pasaría a leerse como parte de la petición del usuario en vez de como
    // un dato del sistema.
    const prompt = buildReportSystemPrompt({
      ...base,
      companyName: 'Electro Hogar',
      instructions: 'Enfócate en la cobranza.',
    });
    const iEmpresa = prompt.indexOf('Electro Hogar');
    const iUsuario = prompt.indexOf('Enfócate en la cobranza');
    // Los dos tienen que ESTAR. Sin este par de líneas, un `indexOf` de -1 (ausente) sería
    // "menor que" el otro y el test pasaría precisamente cuando la directiva desapareció.
    expect(iEmpresa).toBeGreaterThanOrEqual(0);
    expect(iUsuario).toBeGreaterThanOrEqual(0);
    expect(iEmpresa).toBeLessThan(iUsuario);
  });
});

/**
 * CU-868kt96fw — LA INSTRUCCIÓN DEL USUARIO NO SE PIERDE, PERO PUEDE SER IMPOSIBLE.
 *
 * El ticket dice que el campo "Algo más que quieras pedirle" se ignora por completo y manda
 * a buscar dónde se pierde el texto entre el formulario y el prompt. **No se pierde.** Los
 * payloads reales de pg-boss en producción muestran las cuatro instrucciones que se
 * escribieron, íntegras, y este test fija que llegan al prompt.
 *
 * Lo que fallaba es que las cuatro pedían datos POR PRODUCTO con la sección `top_products`
 * SIN marcar: el snapshot no traía un solo producto y el modelo, cumpliendo la regla de no
 * inventar, se callaba. Desde el lado del usuario eso es indistinguible de un campo roto.
 */
describe('la instrucción del usuario llega al prompt', () => {
  const base = { locale: 'es' as const, reportType: 'executive_summary' as const, sections: [] };

  test('el texto viaja íntegro y delimitado', () => {
    const prompt = buildReportSystemPrompt({
      ...base,
      instructions: 'Dame ventas por producto con costo y venta total',
    });
    expect(prompt).toContain('Dame ventas por producto con costo y venta total');
    // Delimitado: sin marcas, una instrucción larga se funde con las reglas de la casa.
    expect(prompt).toContain('<<<');
    expect(prompt).toContain('>>>');
  });

  test('con instrucción, el modelo tiene ORDEN de avisar si el dato no está', () => {
    const prompt = buildReportSystemPrompt({ ...base, instructions: 'ventas por producto' });
    expect(prompt).toContain('NO lo ignores en silencio');
    expect(prompt).toContain('qué sección tendría que agregar');
  });

  test('sin instrucción, esa regla NO se emite', () => {
    // No es tacañería de tokens: sin instrucción la regla no tiene sujeto ("lo que pidió
    // el usuario"), y una regla sin sujeto es ruido que compite con las que sí aplican.
    const prompt = buildReportSystemPrompt(base);
    expect(prompt).not.toContain('NO lo ignores en silencio');
  });

  test('la regla va DESPUÉS de la instrucción, no antes', () => {
    const prompt = buildReportSystemPrompt({ ...base, instructions: 'ventas por producto' });
    const iInstruccion = prompt.indexOf('ventas por producto');
    const iRegla = prompt.indexOf('NO lo ignores en silencio');
    expect(iInstruccion).toBeGreaterThanOrEqual(0);
    expect(iRegla).toBeGreaterThanOrEqual(0);
    // La regla habla SOBRE la instrucción ("si lo que pidió el usuario…"), así que tiene
    // que leerse después de haberla leído. Al revés queda apuntando a nada.
    expect(iRegla).toBeGreaterThan(iInstruccion);
  });

  test('en inglés la regla también está', () => {
    const prompt = buildReportSystemPrompt({
      ...base,
      locale: 'en',
      instructions: 'sales by product this month',
    });
    expect(prompt).toContain('sales by product this month');
    expect(prompt).toContain('do NOT silently ignore it');
  });
});
