/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * EL ORDEN DE LAS TRES REDES DEL POOL — Y POR QUÉ VIVE EN UN SOLO ARCHIVO
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *
 * Hay tres capas que cierran una transacción que nadie cerró, y **una sola de ellas escribe
 * sobre la conexión**. Ese es todo el asunto de este archivo:
 *
 *   1. `WATCHDOG_MS` (lib/db-scope.ts) — hace `rollback` y devuelve la conexión al pool.
 *      **ESCRIBE.** Es la única que deja la conexión reutilizable.
 *   2. `IDLE_TX_TIMEOUT_MS` (db/client.ts) — `idle_in_transaction_session_timeout`.
 *      Postgres MATA el backend. La conexión queda inservible.
 *   3. `MATAR_COLGADAS_SEG` (lib/db-health.ts) — `pg_terminate_backend` desde pool-watch.
 *      También MATA.
 *
 * ⚠️ **LA QUE ESCRIBE VA PRIMERO. SIEMPRE.** Y no es una preferencia de estilo: escribirle a
 * una conexión cuyo backend ya fue terminado **mata el proceso entero**, sin que ningún
 * `try/catch` ni `.catch()` pueda evitarlo.
 *
 * ═══ EL BUG QUE ESCRIBIÓ ESTE ARCHIVO (2026-08-26, producción) ═══
 *
 * Las tres redes se construyeron el mismo día, en tres commits distintos, y quedaron en el
 * orden EXACTAMENTE INVERSO: Postgres 60 s → watchdog 90 s → pool-watch 120 s. O sea que
 * cuando el watchdog despertaba, Postgres ya había matado la sesión treinta segundos antes.
 * El watchdog le escribía `rollback` a un cadáver **por construcción, en el 100 % de los
 * casos**, y el resultado era esto:
 *
 *     [db-scope] transacción sin cerrar tras 90000 ms: se hace ROLLBACK …
 *     TypeError: null is not an object (evaluating 'socket.write')
 *           at nextWrite (…/postgres/src/connection.js:255)
 *     error: script "start" exited with code 1
 *
 * Reproducido local contra Postgres real, idéntico hasta el número de línea. El mecanismo:
 * postgres.js pone `socket = null` al cerrar (connection.js:448) pero conserva el objeto de
 * conexión, y `write()` difiere el envío con `setImmediate(nextWrite)`. Cuando ese timer
 * corre, `socket.write` lanza **fuera de toda promesa**: no hay `await` que lo reciba, así
 * que es una excepción no capturada y Bun termina con código 1.
 *
 * Lo que el usuario veía era otra cosa: *"tarda muchísimo en procesar los Exceles, lleva 5
 * minutos en cola"*. Cada crash reiniciaba el contenedor, pg-boss reencolaba la ingesta, la
 * ingesta volvía a durar más de 90 s, y otra vez. Una carga de Excel no podía terminar nunca.
 *
 * ═══ POR QUÉ SE MUEVEN LAS OTRAS DOS Y NO EL WATCHDOG ═══
 *
 * Bajar el watchdog también ordenaría las redes, y es la opción equivocada: el watchdog es el
 * único que **deshace trabajo**, así que adelantarlo aumenta la probabilidad de revertir una
 * transacción legítima que simplemente iba lenta. Subir a las otras dos no le quita seguridad
 * a nadie —lo que ellas cubren lo cubre antes el watchdog, y ahora de verdad— y deja el
 * margen de tolerancia de una request exactamente donde estaba.
 *
 * ⚠️ AL TOCAR CUALQUIERA DE LOS TRES VALORES: siguen siendo tres redes para tres estados
 * distintos, no una redundancia. El timeout de Postgres alcanza lo que está `idle in
 * transaction`; el watchdog alcanza además lo que quedó ESPERANDO UN LOCK, que no es idle y
 * por eso ese timeout no lo toca — eran las nueve sesiones de la caída. `pool-watch` alcanza
 * lo que se le escapó a las dos anteriores. Hay test del orden (`orden-de-las-redes.test.ts`)
 * y falla si alguien lo invierte.
 */

/** 1 · El watchdog de `reserveScopedConnection`. El único que hace `rollback`. */
export const WATCHDOG_MS = 90_000;

/**
 * 2 · `idle_in_transaction_session_timeout` del pool de la app.
 *
 * 150 s y no los 60 s originales: con 60 s Postgres mataba la sesión ANTES de que el watchdog
 * (90 s) despertara, y el watchdog terminaba escribiéndole a un backend que ya no existía.
 * Sigue siendo una fracción de los 57 minutos que duró la fuga que motivó esta red.
 */
export const IDLE_TX_TIMEOUT_MS = 150_000;

/** 3 · El `pg_terminate_backend` de `pool-watch`. La red más agresiva, y por eso la última. */
export const MATAR_COLGADAS_SEG = 210;
