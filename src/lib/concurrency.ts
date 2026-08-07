/**
 * Ventana deslizante de tareas concurrentes, con recolección de errores.
 *
 * Existe extraída del worker de ingesta y no inline por dos razones. La primera es que la
 * lógica es corta pero fácil de equivocar (ver abajo). La segunda es que probarla dentro del
 * worker exigiría un Postgres y un cliente de Anthropic falsos para verificar algo que no
 * tiene nada que ver con ninguno de los dos.
 *
 * DOS DECISIONES QUE PARECEN DETALLE Y NO LO SON:
 *
 * 1. `Promise.race` para liberar cupo, no `Promise.all`. Con `all` el paralelismo degenera en
 *    tandas: se lanzan N, se espera a que terminen LAS N, se lanzan otras N. Cada tanda va al
 *    ritmo de su tarea más lenta, y con llamadas a un LLM la varianza es enorme (140-220 s
 *    medidos). Con `race` entra una tarea nueva en cuanto sale la primera, y la ventana se
 *    mantiene llena.
 *
 * 2. NO se aborta al primer error: se espera a que TODO lo que está en vuelo termine, y solo
 *    después se devuelven los errores. En la ingesta esto cuesta dinero real — cada tarea en
 *    vuelo es una llamada a Claude ya pagada, y cortar antes de que confirme su transacción
 *    tira ese resultado a la basura y obliga a pagarlo otra vez en el reintento. Quien llama
 *    decide qué hacer con los errores; lo que esta función garantiza es que nada quedó a
 *    medio camino sin darle la oportunidad de terminar.
 *
 * No devuelve resultados a propósito: las tareas de la ingesta confirman sus efectos en la
 * base y solo acumulan contadores por closure. Una versión que junte valores es fácil de
 * agregar el día que haga falta, pero hoy sería API sin uso.
 */
export async function runWithConcurrency<T>(
  items: readonly T[],
  worker: (item: T, index: number) => Promise<void>,
  limit: number,
): Promise<{ errors: unknown[] }> {
  const efectivo = Math.max(1, Math.floor(limit));
  const enCurso = new Set<Promise<void>>();
  const errors: unknown[] = [];

  for (const [index, item] of items.entries()) {
    // El `catch` va acá y no afuera: convierte cada tarea en una promesa que NUNCA rechaza,
    // que es lo que permite usar `race` sin que un rechazo temprano se propague y sin dejar
    // rechazos sin manejar cuando se descarta el resultado del `race`.
    const tarea = worker(item, index).catch((err: unknown) => {
      errors.push(err);
    });

    enCurso.add(tarea);
    // `finally` se registra ANTES de que `race` vea esta promesa, así que su callback corre
    // antes de que despierte el `await` de abajo: cuando se reanuda el bucle, el cupo ya está
    // liberado de verdad. Al revés, `enCurso.size` seguiría contando una tarea terminada y la
    // ventana quedaría permanentemente por debajo del límite.
    void tarea.finally(() => enCurso.delete(tarea));

    if (enCurso.size >= efectivo) await Promise.race(enCurso);
  }

  await Promise.allSettled(enCurso);
  return { errors };
}
