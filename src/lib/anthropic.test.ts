import { describe, expect, test } from 'bun:test';

// env.ts validates DATABASE_URL at import time even for modules (like this one) that
// never touch the DB — same stub pattern as modules/health/index.test.ts.
process.env.DATABASE_URL ??= 'postgres://smoke:smoke@localhost:5432/smoke';

const {
  assertZdrModel,
  estimateCostUsd,
  resolveRatePerMtok,
  assertNotTruncated,
  SheetOutputTruncatedError,
  CLASSIFY_ROWS_SCHEMA,
} = await import('./anthropic');

describe('assertZdrModel', () => {
  test('accepts the ZDR-verified model', () => {
    expect(() => assertZdrModel('claude-sonnet-5')).not.toThrow();
  });

  test('rejects any other model', () => {
    expect(() => assertZdrModel('claude-opus-5')).toThrow();
    expect(() => assertZdrModel('gpt-4')).toThrow();
  });
});

describe('anthropicModel resuelve desde configuración, nunca hardcodeado (CU-868kfvazj)', () => {
  test('ANTHROPIC_MODEL en env determina el modelo sin tocar código', async () => {
    const prevValue = process.env.ANTHROPIC_MODEL;
    try {
      process.env.ANTHROPIC_MODEL = 'claude-sonnet-5';
      // Cache-bust: env.ts ya fue importado arriba con el valor por defecto: un
      // import normal reusaría ese módulo cacheado en vez de releerlo con el env
      // recién seteado.
      const { env: freshEnv } = await import(`./env?cb=${crypto.randomUUID()}`);
      expect(freshEnv.anthropicModel).toBe('claude-sonnet-5');
    } finally {
      if (prevValue === undefined) delete process.env.ANTHROPIC_MODEL;
      else process.env.ANTHROPIC_MODEL = prevValue;
    }
  });

  test('un modelo no verificado para ZDR sigue rechazado aunque venga de config', async () => {
    const prevValue = process.env.ANTHROPIC_MODEL;
    try {
      process.env.ANTHROPIC_MODEL = 'claude-opus-5';
      const { env: freshEnv } = await import(`./env?cb=${crypto.randomUUID()}`);
      expect(() => assertZdrModel(freshEnv.anthropicModel)).toThrow();
    } finally {
      if (prevValue === undefined) delete process.env.ANTHROPIC_MODEL;
      else process.env.ANTHROPIC_MODEL = prevValue;
    }
  });
});

/**
 * CU-868kjc9d6. La regresión que se vigila no es la aritmética: es que `cost_usd` se
 * quede calculando con una tarifa vencida SIN QUE NADA FALLE. La tarifa introductoria de
 * `claude-sonnet-5` ($2/$10) vence el 2026-08-31 y la de lista ($3/$15) rige desde el
 * 2026-09-01; con la constante fija anterior, toda fila insertada a partir de esa fecha
 * habría subestimado el costo un 33% en un ledger append-only que no se corrige.
 *
 * Todos los casos fijan la fecha EXPLÍCITAMENTE. El test viejo (`estimateCostUsd(1M, 1M)`
 * ≈ 12) dependía de la fecha del sistema: pasaba en agosto y habría empezado a fallar
 * solo el 1 de septiembre — exactamente el problema del ticket, pero en la suite.
 */
const UN_MILLON = 1_000_000;
const dia = (iso: string) => new Date(`${iso}T12:00:00Z`);

describe('estimateCostUsd — la tarifa sale de la fecha del evento', () => {
  test('antes del corte cobra la tarifa introductoria ($2/$10)', () => {
    expect(estimateCostUsd(UN_MILLON, UN_MILLON, 'claude-sonnet-5', dia('2026-08-12'))).toBeCloseTo(
      12,
      6,
    );
  });

  test('después del corte cobra la tarifa de lista ($3/$15) sin tocar código', () => {
    // El caso que el ticket viene a evitar: mismo consumo, 50% más de costo real.
    expect(estimateCostUsd(UN_MILLON, UN_MILLON, 'claude-sonnet-5', dia('2026-09-01'))).toBeCloseTo(
      18,
      6,
    );
  });

  test('el corte cae donde debe: 08-31 es intro y 09-01 ya es lista', () => {
    // Los dos días frontera, porque un `<` en vez de `<=` desplazaría el cambio un día
    // y nadie lo notaría.
    expect(resolveRatePerMtok('claude-sonnet-5', dia('2026-08-31'))).toEqual({
      input: 2.0,
      output: 10.0,
      exact: true,
    });
    expect(resolveRatePerMtok('claude-sonnet-5', dia('2026-09-01'))).toEqual({
      input: 3.0,
      output: 15.0,
      exact: true,
    });
  });

  test('un modelo sin tarifa en el catálogo SOBRE-estima y se marca como inexacto', () => {
    // Nunca sub-estimar: un costo inflado se nota al revisarlo, uno deflactado se
    // confunde con una buena noticia. `exact: false` es la señal de que hay que
    // agregar la ventana.
    const tarifa = resolveRatePerMtok('claude-opus-5', dia('2026-09-01'));
    expect(tarifa.exact).toBe(false);
    expect(tarifa.input).toBeGreaterThanOrEqual(3.0);
    expect(tarifa.output).toBeGreaterThanOrEqual(15.0);
  });

  test('una fecha anterior a todo tramo conocido también es inexacta, no cero', () => {
    // Cobrar 0 por no encontrar tarifa sería la peor variante del bug original.
    const tarifa = resolveRatePerMtok('claude-sonnet-5', dia('2020-01-01'));
    expect(tarifa.exact).toBe(false);
    expect(tarifa.input).toBeGreaterThan(0);
  });

  test('cero tokens cuesta cero', () => {
    expect(estimateCostUsd(0, 0, 'claude-sonnet-5', dia('2026-09-01'))).toBe(0);
  });
});

describe('assertNotTruncated (CU-868kmwdqu)', () => {
  test('una respuesta cortada por max_tokens NO es una respuesta válida', () => {
    // El caso real: el modelo corta a media respuesta y el JSON llega partido. Antes
    // esto caía en el catch del JSON.parse y se reportaba como "not valid JSON despite
    // structured output" — un mensaje que manda a investigar structured output, que
    // garantiza la forma de la respuesta pero no que quepa.
    expect(() => assertNotTruncated('max_tokens', 'Ventas', 521)).toThrow(
      SheetOutputTruncatedError,
    );
  });

  test('el error dice qué hoja fue y cuántas filas llevaba, que es lo accionable', () => {
    try {
      assertNotTruncated('max_tokens', 'Ventas', 521);
      throw new Error('debió lanzar');
    } catch (err) {
      expect((err as Error).message).toContain('Ventas');
      expect((err as Error).message).toContain('521');
    }
  });

  test('un final normal pasa de largo', () => {
    expect(() => assertNotTruncated('end_turn', 'Ventas', 10)).not.toThrow();
    expect(() => assertNotTruncated(null, 'Ventas', 10)).not.toThrow();
    expect(() => assertNotTruncated(undefined, 'Ventas', 10)).not.toThrow();
  });
});

describe('CLASSIFY_ROWS_SCHEMA — el 400 que la API devuelve antes de generar', () => {
  /**
   * La primera llamada real con el esquema compacto (2026-08-12) volvió con:
   *
   *   400 "Enum value 'revenue' does not match declared type '['string','null']'"
   *
   * `{type: ['string','null'], enum: [...valores, null]}` es JSON Schema perfectamente
   * válido y la API de structured outputs lo RECHAZA. Un campo anulable con enum se
   * declara con `anyOf`.
   *
   * Por qué merece un test y no solo el comentario: es el peor modo de fallo de todo el
   * módulo. No degrada nada — rechaza la petición completa, así que serían el 100 % de
   * los documentos fallando, y ninguna prueba unitaria lo tocaba porque el esquema solo
   * se valida del lado de Anthropic. Se descubrió gastando dinero; no se vuelve a
   * descubrir así.
   */
  type Nodo = { type?: unknown; enum?: unknown; anyOf?: { type?: unknown; enum?: string[] }[] };

  const recorrer = (nodo: unknown, ruta: string, visitar: (n: Nodo, r: string) => void): void => {
    if (!nodo || typeof nodo !== 'object') return;
    visitar(nodo as Nodo, ruta);
    for (const [k, v] of Object.entries(nodo)) recorrer(v, `${ruta}.${k}`, visitar);
  };

  test('ningún enum convive con un `type` de varias opciones', () => {
    const infractores: string[] = [];
    recorrer(CLASSIFY_ROWS_SCHEMA, '$', (n, ruta) => {
      if (Array.isArray(n.enum) && Array.isArray(n.type)) infractores.push(ruta);
    });
    expect(infractores).toEqual([]);
  });

  test('el enum de tipo contable sigue siendo anulable, vía anyOf', () => {
    // No basta con que no reviente: `t` TIENE que aceptar null, porque invoice y bill no
    // llevan tipo contable. Quitarle el null para esquivar el 400 rompería la mitad de
    // las filas de otra forma.
    let t: Nodo | undefined;
    recorrer(CLASSIFY_ROWS_SCHEMA, '$', (n, ruta) => {
      if (ruta.endsWith('properties.rows.items.properties.t')) t = n;
    });
    expect(t?.anyOf).toBeDefined();
    expect(t?.anyOf?.some((o) => o.type === 'null')).toBe(true);
    expect(t?.anyOf?.some((o) => o.enum?.includes('revenue'))).toBe(true);
  });
});
