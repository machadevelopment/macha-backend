import type { ScopedConnection } from '@/lib/db-scope';

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * REGISTRAR EL CIERRE DE UNA CONEXIÓN RESERVADA, INCLUIDO EL CASO QUE LOS HOOKS NO CUBREN
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *
 * Los tres guards que reservan una conexión por request —`tenant.derive`, `identity.derive` y
 * `admin.guard`— tenían la misma pieza copiada: un `WeakMap<Request, release>` y dos hooks que
 * lo consumen. Vive acá una sola vez porque el agujero que se cierra abajo es el mismo en los
 * tres, y arreglarlo en dos de tres es no arreglarlo.
 *
 * ═══ EL AGUJERO: EL CLIENTE QUE SE VA ═══
 *
 * El cierre se delegaba a `onAfterHandle`/`onError`. Si el cliente **se desconecta a mitad del
 * request** —cierra la pestaña, navega a otra pantalla, cancela un fetch— Elysia no considera
 * que el request haya terminado ni que haya fallado, así que **no corre ninguno de los dos**.
 * La transacción queda abierta con sus locks hasta que el watchdog de `db-scope` la recoge 90
 * segundos después.
 *
 * Eso es exactamente lo que se veía en producción: el watchdog disparándose cada pocos minutos
 * con el contenedor recién desplegado y sin carga inusual. El propio comentario de
 * `db-scope.ts` ya nombraba este caso —"cliente que se desconecta, request abortada"— como el
 * motivo de que el watchdog exista; lo que faltaba era cerrarlo en vez de taparlo.
 *
 * Y el dashboard es el peor caso: dispara varias llamadas en paralelo al cargar, así que
 * navegar antes de que terminen aborta varias a la vez.
 *
 * ═══ POR QUÉ `abort` Y NO OTRA RED ═══
 *
 * `request.signal` se dispara en el momento en que el cliente se va, así que la conexión vuelve
 * al pool **de inmediato** en vez de a los 90 s. El watchdog sigue existiendo y sigue haciendo
 * falta: cubre lo que ni los hooks ni esto alcanzan (una excepción fuera del ciclo, un camino
 * de salida futuro). La diferencia es que pasa a ser lo que debe ser —una red de último
 * recurso— en vez del mecanismo de cierre de todos los días.
 *
 * ═══ ROLLBACK Y NO COMMIT ═══
 *
 * Mismo criterio que el watchdog: quien se desconectó nunca vio la respuesta, así que no se
 * puede afirmar que su trabajo terminara. Commitear a ciegas escribiría contabilidad a medias.
 * En la práctica estos guards solo LEEN, pero la regla se sostiene por lo que la transacción
 * podría llegar a contener, no por lo que hoy contiene.
 *
 * `release` es idempotente por el `released` de `db-scope`, así que la carrera entre el abort y
 * un `onAfterHandle` tardío no puede cerrar dos veces.
 *
 * ═══ ⚠️ UNA LISTA POR REQUEST, NO UN CIERRE — Y ESTO COSTÓ UN TEST EN ROJO ═══
 *
 * Los tres guards tenían cada uno su propio `WeakMap`, así que unificarlos parecía limpieza
 * pura. No lo es: con un solo valor por request, **un request que pasa por DOS guards hace que
 * el segundo pise la entrada del primero**, y entonces solo una de las dos conexiones
 * reservadas se cierra. La otra queda abierta hasta que el watchdog la recoja — o sea que
 * consolidar los mapas habría CREADO la fuga que este trabajo vino a cerrar.
 *
 * Lo destapó el suite de integración: `sql.end()` del teardown se quedaba esperando a una
 * conexión que nadie devolvía, y el fallo aparecía como un timeout en el `afterAll` del último
 * archivo — a varios archivos de distancia de la causa, y sin mencionarla.
 *
 * Con una lista, cada guard agrega su cierre y `cerrarPendiente` los cierra todos. Es además
 * más correcto que los tres mapas originales, que funcionaban solo porque nadie los cruzaba.
 */
const pendientes = new WeakMap<Request, Array<(commit: boolean) => Promise<void>>>();

export function registrarCierre(request: Request, scoped: ScopedConnection): void {
  const cerrar = (commit: boolean) => (commit ? scoped.commit() : scoped.rollback());
  const lista = pendientes.get(request) ?? [];
  lista.push(cerrar);
  pendientes.set(request, lista);

  /*
   * `once: true` para no dejar el listener colgado del signal después de disparar. El signal
   * vive lo que vive el request, así que tampoco acumularía — pero un listener que se quita
   * solo es una cosa menos que razonar.
   *
   * Cierra SOLO lo suyo y no la lista entera: si dos guards reservaron, cada uno registró su
   * propio listener y cada uno cierra el suyo.
   */
  request.signal?.addEventListener(
    'abort',
    () => {
      const actual = pendientes.get(request);
      if (!actual?.includes(cerrar)) return;
      pendientes.set(
        request,
        actual.filter((c) => c !== cerrar),
      );
      void cerrar(false).catch((err) => {
        console.error('[db-scope] fallo al cerrar tras la desconexión del cliente:', err);
      });
    },
    { once: true },
  );
}

/** Cierra TODO lo que quedó registrado para este request. No hace nada si ya se cerró. */
export async function cerrarPendiente(request: Request, commit: boolean): Promise<void> {
  const lista = pendientes.get(request);
  if (!lista?.length) return;
  pendientes.delete(request);
  // En serie y no en paralelo: son conexiones del mismo pool y el orden de devolución no
  // importa, pero un `Promise.all` haría que un fallo deje al resto sin cerrar.
  for (const cerrar of lista) await cerrar(commit);
}
