import { describe, expect, test } from 'bun:test';

// env.ts valida DATABASE_URL al importar, incluso para lo que no toca la base — mismo
// patrón de stub que anthropic.test.ts.
process.env.DATABASE_URL ??= 'postgres://smoke:smoke@localhost:5432/smoke';

const { cacheHitRate } = await import('./ai-usage');

describe('cacheHitRate — el número que contesta "¿el caché está pegando?"', () => {
  test('sin actividad devuelve null, no 0 %', () => {
    // 0 % en una empresa que no ha llamado a la IA es una alarma falsa: dice "el caché
    // falla" cuando lo cierto es "no hay nada que medir".
    expect(
      cacheHitRate({ totalInputTokens: 0, totalCacheReadTokens: 0, totalCacheCreationTokens: 0 }),
    ).toBe(null);
  });

  test('escribir el caché NO cuenta como acierto', () => {
    /*
     * La primera llamada de un documento escribe el caché y no lee nada. Esa llamada costó
     * MÁS que si no hubiera caché (1,25x sobre la tarifa de entrada), así que su tasa de
     * acierto es 0. Contarla como acierto sería contar el costo como ahorro — y el panel
     * mostraría el caché funcionando justo en la llamada donde no funcionó.
     */
    expect(
      cacheHitRate({
        totalInputTokens: 6_500,
        totalCacheReadTokens: 0,
        totalCacheCreationTokens: 2_000,
      }),
    ).toBe(0);
  });

  test('el denominador es TODA la entrada, no solo la parte cacheable', () => {
    /*
     * El caso real de un documento de ingesta: 10 lotes, prefijo de ~2.000 tokens que se
     * reusa 9 veces, y ~6.500 tokens de filas del cliente por lote que no cachea nadie.
     *
     * Contra solo lo cacheable daría 90 % y se leería como "el caché va perfecto". Contra
     * el total da ~22 %, que es la verdad útil: la mayor parte de lo que mandamos sigue
     * siendo entrada fresca, y ahí es donde queda margen.
     */
    const r = cacheHitRate({
      totalInputTokens: 65_000,
      totalCacheReadTokens: 18_000,
      totalCacheCreationTokens: 2_000,
    })!;
    expect(r).toBeCloseTo(0.212, 3);
    expect(r).toBeLessThan(0.5);
  });

  test('todo desde caché da 1', () => {
    expect(
      cacheHitRate({
        totalInputTokens: 0,
        totalCacheReadTokens: 5_000,
        totalCacheCreationTokens: 0,
      }),
    ).toBe(1);
  });
});
