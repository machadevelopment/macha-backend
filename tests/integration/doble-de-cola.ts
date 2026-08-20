/**
 * ═══════════════════════════════════════════════════════════════════════════════════════
 * UN SOLO DOBLE DE `@/queue` PARA TODA LA SUITE DE INTEGRACIÓN
 * ═══════════════════════════════════════════════════════════════════════════════════════
 *
 * ═══ POR QUÉ ESTO EXISTE, Y POR QUÉ NO ES UNA CUESTIÓN DE ESTILO ═══
 *
 * `mock.module` de Bun es GLOBAL AL PROCESO, y la suite de integración corre en UNA sola
 * invocación de `bun test`. O sea que el doble de `@/queue` que escribe un archivo aplica a
 * todos los demás, y si dos archivos lo doblan, **el último que se carga gana**.
 *
 * Cinco archivos lo doblaban por separado, cada uno exportando las dos o tres cosas que él
 * necesitaba. Mientras nadie importara `@/queue` de verdad, funcionaba por casualidad. Al
 * agregar un test que monta el módulo de ingesta completo —que importa `RETRY_POLICY`— la
 * casualidad se terminó, y lo hizo de la peor forma posible:
 *
 *     SyntaxError: Export named 'RETRY_POLICY' not found in module 'src/queue/index.ts'
 *
 * Un error de importación que no menciona ni el archivo culpable ni el mock, **que pasaba en
 * local y fallaba en CI** (el orden de carga de archivos no es el mismo), y que no se arregla
 * mirando el archivo que lo reporta. Lo atrapó el job `integration`, que es exactamente para
 * lo que está.
 *
 * ═══ POR QUÉ SE ESCRIBE A MANO Y NO CON `...await import('@/queue')` ═══
 *
 * Es el patrón que se usa para `@/lib/s3` y `@/lib/rate-limit` en esta misma suite, y acá NO
 * sirve: `src/queue/index.ts` hace `export const boss = new PgBoss(...)` en el cuerpo del
 * módulo. Importarlo construye el cliente de pg-boss durante los tests. No conecta —eso pasa
 * en `.start()`— pero es un objeto con temporizadores propios que no tiene nada que hacer en
 * una corrida de tests, y dejarlo vivo es la clase de cosa que cuelga una suite al final sin
 * decir por qué.
 *
 * La superficie de acá tiene que seguir a la de `src/queue/index.ts`. Si alguien agrega un
 * export nuevo y algún módulo lo importa, el síntoma es el mismo `SyntaxError` de arriba — con
 * la ventaja de que ahora hay UN lugar donde arreglarlo en vez de cinco.
 */

/** Todo lo que la suite encoló, en orden. Es lo que se afirma en los tests. */
export type Encolado = { queue: string; payload: unknown };

/** Los handlers que registró cada worker, para poder invocarlos a mano. */
export type HandlerDeCola = (payload: never) => Promise<void>;

export const QUEUES = {
  excelIngest: 'excel.ingest',
  documentPromote: 'document.promote',
  reportTick: 'report.tick',
  reportGenerate: 'report.generate',
  alertEvaluate: 'alert.evaluate',
  emailSend: 'email.send',
  dbBackup: 'db.backup',
} as const;

/**
 * Vacío a propósito: es un mapa de opciones de reintento por cola, y ningún test afirma nada
 * sobre ellas. Lo que hacía falta es que el EXPORT exista, porque el módulo de ingesta lo
 * importa y sin él la importación revienta antes de correr una sola aserción.
 */
export const RETRY_POLICY: Record<string, unknown> = {};

/**
 * Fábrica del doble. Devuelve el objeto que se le pasa a `mock.module` y, al lado, las dos
 * cosas que los tests necesitan mirar: lo que se encoló y el handler que se registró.
 *
 * Se devuelven juntos para que no haya que declarar los arrays sueltos en cada archivo — que es
 * de donde venían las cinco versiones divergentes.
 */
export function crearDobleDeCola() {
  const encolados: Encolado[] = [];
  const handlers = new Map<string, HandlerDeCola>();

  const modulo = {
    QUEUES,
    RETRY_POLICY,
    /**
     * `boss` se expone como un objeto inerte y no como el real. Algún módulo podría importarlo
     * (hoy ninguno lo hace fuera de `startQueue`), y que exista vale más que lo que cuesta.
     */
    boss: {},
    startQueue: async () => ({}),
    enqueue: async (queue: string, payload: unknown) => {
      encolados.push({ queue, payload });
      return 'job-id-de-test';
    },
    registerWorker: async (queue: string, handler: HandlerDeCola) => {
      handlers.set(queue, handler);
      return `worker-de-test-${queue}`;
    },
  };

  return { modulo, encolados, handlers };
}
