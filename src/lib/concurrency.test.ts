import { describe, expect, test } from 'bun:test';
import { runWithConcurrency } from './concurrency';

/**
 * Lo que hay que demostrar acá no es que "corre en paralelo" —eso es fácil de creer— sino
 * las tres propiedades de las que depende la ingesta y que un scheduler mal escrito rompe en
 * silencio: que la ventana se mantenga LLENA, que ninguna tarea se pierda, y que un fallo no
 * cancele las llamadas a Claude que ya se están pagando.
 */
const tick = () => new Promise<void>((r) => setTimeout(r, 5));

describe('runWithConcurrency', () => {
  test('corre todas las tareas, una sola vez cada una', async () => {
    const vistas: number[] = [];
    const { errors } = await runWithConcurrency(
      [1, 2, 3, 4, 5, 6, 7],
      async (n) => {
        await tick();
        vistas.push(n);
      },
      3,
    );

    expect(errors).toEqual([]);
    expect(vistas.sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  test('nunca excede el límite', async () => {
    let enVuelo = 0;
    let pico = 0;

    await runWithConcurrency(
      Array.from({ length: 20 }, (_, i) => i),
      async () => {
        enVuelo++;
        pico = Math.max(pico, enVuelo);
        await tick();
        enVuelo--;
      },
      4,
    );

    expect(pico).toBe(4);
  });

  /**
   * La propiedad que justifica `race` en vez de `all`. Con tandas, 6 tareas de las cuales una
   * es lenta y con límite 3 harían: tanda 1 (espera a la lenta) y tanda 2 -> el pico de
   * concurrencia caería a 1 mientras la lenta termina sola. Con ventana deslizante, las
   * rápidas siguientes entran de inmediato y el pico se mantiene en el límite.
   */
  test('mantiene la ventana llena aunque una tarea sea mucho más lenta', async () => {
    let enVuelo = 0;
    const picos: number[] = [];

    await runWithConcurrency(
      [100, 5, 5, 5, 5, 5],
      async (ms) => {
        enVuelo++;
        picos.push(enVuelo);
        await new Promise<void>((r) => setTimeout(r, ms));
        enVuelo--;
      },
      3,
    );

    // Si degenerara en tandas, la última tarea arrancaría sola (pico 1) esperando a la de
    // 100 ms. Con la ventana deslizante arranca acompañada.
    expect(Math.max(...picos.slice(1))).toBeGreaterThanOrEqual(3);
  });

  test('un fallo no cancela lo que ya está en vuelo, y se reportan todos', async () => {
    const terminadas: number[] = [];

    const { errors } = await runWithConcurrency(
      [0, 1, 2, 3, 4, 5],
      async (n) => {
        await tick();
        if (n % 2 === 0) throw new Error(`falla ${n}`);
        terminadas.push(n);
      },
      3,
    );

    // Las tres impares completaron aunque las pares fallaran. Esto es lo que evita tirar
    // llamadas a Claude ya pagadas: en la ingesta cada "terminada" confirmó su transacción.
    expect(terminadas.sort((a, b) => a - b)).toEqual([1, 3, 5]);
    expect(errors).toHaveLength(3);
    expect((errors[0] as Error).message).toBe('falla 0');
  });

  test('un límite inválido no deja el trabajo sin hacer', async () => {
    // Un `INTAKE_BATCH_CONCURRENCY` mal puesto en Railway (0, vacío, negativo) no debe dejar
    // la ingesta sin procesar nada: degrada a serie, que es lento pero correcto.
    for (const limite of [0, -3, 0.5, Number.NaN]) {
      const hechas: number[] = [];
      await runWithConcurrency([1, 2, 3], async (n) => void hechas.push(n), limite);
      expect(hechas).toHaveLength(3);
    }
  });

  test('una lista vacía no explota', async () => {
    const { errors } = await runWithConcurrency([], async () => {}, 5);
    expect(errors).toEqual([]);
  });
});
