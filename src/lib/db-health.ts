import postgres from 'postgres';
import { sql } from '@/db/client';
import { env } from '@/lib/env';

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * MIRAR EL POOL, PORQUE NADIE SE ENTERÓ DURANTE UNA HORA (caída del 2026-08-26)
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *
 * El 2026-08-26 una transacción quedó abierta 57 minutos, nueve sesiones se encolaron detrás de
 * su lock y el pool de `macha_app` (`max: 10`) quedó sin conexiones libres. Todo lo que toca la
 * base empezó a fallar de forma intermitente.
 *
 * Lo que hizo que durara una hora no fue la dificultad de arreglarlo —fue de un comando— sino
 * que **nada lo estaba mirando**. Se descubrió por un reclamo del dueño del producto.
 *
 * ═══ Y `/health` DECÍA QUE TODO ESTABA BIEN ═══
 *
 * Esto es la parte que hay que recordar: durante la caída se le pegaron 20 llamadas seguidas a
 * `GET /health` y devolvió 200 en las 20. Sirvió para DESCARTAR el backend, que era justo lo
 * contrario de lo que hacía falta. `modules/health` responde un objeto fijo sin tocar la base,
 * así que un pool agotado le resulta invisible.
 *
 * De ahí las tres piezas que este archivo habilita: un chequeo que SÍ mira el pool
 * (`/health/db`), un job periódico que avisa antes de que el usuario lo note, y la
 * auto-recuperación del final.
 *
 * ⚠️ CORRECCIÓN A UNA VERSIÓN ANTERIOR DE ESTA MISMA CABECERA. Decía que `/health/db` servía
 * "para que Railway pueda reiniciar el servicio solo". **Es falso**: el healthcheck de Railway
 * solo corre al desplegar —*"Railway does not monitor the healthcheck endpoint after the
 * deployment has gone live"*— y de hecho ya estaba configurado durante la caída sin reiniciar
 * nada. Lo que `/health/db` sí hace es frenar un DESPLIEGUE que arranca sin base, y dar un
 * diagnóstico que un `curl` puede leer. La auto-recuperación tuvo que construirse por eso.
 *
 * ═══ QUÉ SE MIDE, Y POR QUÉ ESTAS DOS COSAS Y NO EL CONTEO DE CONEXIONES ═══
 *
 * Contar conexiones no distingue "diez requests trabajando" —sano y deseable— de "diez
 * esperando a una muerta". Las dos señales que sí lo distinguen son:
 *
 *   · `transaccionesColgadas`: transacciones ABIERTAS y SIN ACTIVIDAD por más del umbral.
 *     Ninguna request legítima queda idle dentro de una transacción; es siempre una fuga.
 *   · `sesionesBloqueadas`: sesiones que Postgres reporta esperando el lock de otra. Una o dos
 *     por un instante es contención normal; varias sostenidas es el pool agotándose.
 *
 * Se consulta `pg_stat_activity`, que es catálogo: no toma locks ni compite con nada.
 */

/** Una transacción idle más allá de esto es una fuga, no trabajo lento. */
const UMBRAL_COLGADA_SEG = 30;

/** A partir de acá el pool (`max: 10`) está lo bastante comprometido para avisar. */
const UMBRAL_BLOQUEADAS = 3;

export interface SaludDelPool {
  /** Transacciones abiertas e inactivas por más de `UMBRAL_COLGADA_SEG`. */
  transaccionesColgadas: number;
  /** Sesiones esperando el lock de otra sesión. */
  sesionesBloqueadas: number;
  /** Conexiones totales del rol de la app. Contexto, no criterio. */
  conexionesDeLaApp: number;
  /** Segundos de la transacción abierta más antigua, o `null` si no hay ninguna. */
  colgadaMasViejaSeg: number | null;
  /** `true` cuando conviene actuar: hay una fuga o el pool se está comprometiendo. */
  requiereAtencion: boolean;
}

export async function medirSaludDelPool(): Promise<SaludDelPool> {
  /*
   * `pg_blocking_pids` en lugar de leer `pg_locks` a mano: resuelve la cadena completa de
   * espera —incluidos los casos en que A espera a B que espera a C— y es lo que de verdad
   * responde "¿hay alguien atascado?".
   *
   * El filtro por `usename` es deliberado: las migraciones y los scripts corren con el rol
   * dueño y sus transacciones largas son legítimas. Lo que puede tumbar el producto es el pool
   * de la app.
   */
  const [fila] = await sql<
    { colgadas: string; bloqueadas: string; conexiones: string; mas_vieja: string | null }[]
  >`
    select
      count(*) filter (
        where state = 'idle in transaction'
          and now() - state_change > make_interval(secs => ${UMBRAL_COLGADA_SEG})
      )::text as colgadas,
      count(*) filter (where cardinality(pg_blocking_pids(pid)) > 0)::text as bloqueadas,
      count(*)::text as conexiones,
      max(
        case when state = 'idle in transaction'
             then extract(epoch from now() - state_change) end
      )::int::text as mas_vieja
    from pg_stat_activity
    where usename = current_user
  `;

  const transaccionesColgadas = Number(fila?.colgadas ?? 0);
  const sesionesBloqueadas = Number(fila?.bloqueadas ?? 0);

  return {
    transaccionesColgadas,
    sesionesBloqueadas,
    conexionesDeLaApp: Number(fila?.conexiones ?? 0),
    colgadaMasViejaSeg: fila?.mas_vieja == null ? null : Number(fila.mas_vieja),
    // Cualquiera de las dos alcanza: una fuga sin bloqueados todavía es una fuga, y varios
    // bloqueados sin fuga visible es igual de urgente porque el pool se está llenando.
    requiereAtencion: transaccionesColgadas > 0 || sesionesBloqueadas >= UMBRAL_BLOQUEADAS,
  };
}

/** El aviso en palabras, para el log y para Sentry. */
export function describirSalud(s: SaludDelPool): string {
  const partes = [
    `${s.transaccionesColgadas} transacción(es) abierta(s) e inactiva(s) por más de ${UMBRAL_COLGADA_SEG}s`,
    `${s.sesionesBloqueadas} sesión(es) esperando el lock de otra`,
    `${s.conexionesDeLaApp} conexiones del rol de la app`,
  ];
  if (s.colgadaMasViejaSeg !== null) {
    partes.push(`la más vieja lleva ${s.colgadaMasViejaSeg}s abierta`);
  }
  return partes.join(' · ');
}

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * CURARSE SOLO, PORQUE EN RAILWAY NADIE MÁS LO VA A HACER
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *
 * Esto existe por una CORRECCIÓN. El 2026-08-26 se puso `/health/db` como healthcheck del
 * servicio creyendo que un pool agotado haría que Railway reiniciara. **Es falso**, y está en su
 * documentación: *"Railway does not monitor the healthcheck endpoint after the deployment has
 * gone live"*. El healthcheck es una compuerta de DESPLIEGUE, no una sonda de vida.
 *
 * La prueba de que es falso vino de la realidad, no de los docs: el path YA estaba configurado
 * durante la caída y no reinició nada, porque no tenía que hacerlo.
 *
 * O sea que la plataforma no aporta ninguna capa de auto-recuperación. La única forma es que la
 * app se cure a sí misma, y esta función es esa capa.
 *
 * ═══ POR QUÉ ES SEGURO, Y POR QUÉ CAMBIÉ DE OPINIÓN ═══
 *
 * `pool-watch` nació deliberadamente SIN esto, con el argumento de que terminar sesiones de
 * forma automática era "un martillo apuntando a la base de clientes reales". Ese razonamiento
 * era demasiado conservador y queda corregido acá:
 *
 * Una transacción en estado `idle in transaction` **no está ejecutando nada** y **no hizo
 * commit**. Deshacerla descarta trabajo que ningún cliente vio y que nadie va a poder ver
 * nunca, porque su dueña se perdió. No es un martillo: es una operación demostrablemente sin
 * pérdida — literalmente la misma que un operador ejecutó a mano ese día para levantar el
 * producto.
 *
 * ═══ LOS TRES CANDADOS, Y NINGUNO ES DECORATIVO ═══
 *
 * 1. Solo el rol de la APP, comparado por NOMBRE contra el usuario de `APP_DATABASE_URL` (no
 *    `current_user`: la consulta la ejecuta el dueño, ver más abajo). Las migraciones y los
 *    scripts corren con el rol dueño y sus transacciones largas son legítimas.
 * 2. Solo `idle in transaction`. **Nunca** una sesión `active`: esa está ejecutando algo, y
 *    cortarla sí puede interrumpir la promoción de un archivo a mitad de camino.
 * 3. Solo pasados `UMBRAL_MATAR_SEG`, que va DESPUÉS de las otras dos redes (Postgres 60 s,
 *    watchdog 90 s). Si algo llegó hasta acá es porque esas dos no lo alcanzaron, así que esta
 *    capa no compite con ellas por cerrar la misma transacción.
 *
 * ═══ QUÉ NO TOCA ═══
 *
 * Las sesiones BLOQUEADAS. Están esperando un lock, o sea trabajando: en cuanto la colgada se
 * va, avanzan solas. Cortarlas sería abortar requests que iban a completarse bien.
 *
 * ═══ CORRE CON EL ROL DUEÑO, Y ESO LO DESCUBRIÓ EL TEST ═══
 *
 * La primera versión usaba el pool de la app y **fallaba siempre** contra Postgres real:
 *
 *     PostgresError: permission denied to terminate process
 *
 * `macha_app` es un rol restringido a propósito (migración 0010) y no puede señalizar sesiones.
 * O sea que esta capa habría lanzado una excepción en cada ejecución, la habría tragado el
 * `catch` del job, y nos habríamos enterado en la próxima caída — con el consuelo de creer que
 * estábamos cubiertos. Es exactamente lo que estos tests de integración existen para atrapar.
 *
 * Se usa una conexión del rol DUEÑO, el mismo precedente que `tenant-provisioning.ts` para la
 * única operación que exige propiedad. La alternativa —`GRANT pg_signal_backend TO macha_app`—
 * se descarta: le daría al rol restringido la capacidad de señalizar cualquier backend no
 * superusuario, y mantener a `macha_app` sin privilegios que no necesita es una regla del
 * proyecto, no una preferencia.
 *
 * ⚠️ El filtro pasa a ser el NOMBRE del rol de la app, no `current_user`, porque ahora quien
 * consulta es el dueño. Y si los dos roles resultan ser el mismo —`APP_DATABASE_URL` sin
 * configurar, que según CLAUDE.md cae a `DATABASE_URL`— esta capa **no hace nada**: sin la
 * distinción de roles no puede separar una fuga de la app de una migración en curso, y una
 * migración entre sentencias también está `idle in transaction`. Preferir no actuar es lo
 * único defendible ahí.
 */
const UMBRAL_MATAR_SEG = 120;

/**
 * Conexión dedicada con el rol dueño, con UNA sola conexión: esto corre cada dos minutos y no
 * necesita concurrencia. Se crea perezosamente para no abrir una conexión extra en los procesos
 * que nunca llaman a esta función (los tests unitarios, por ejemplo).
 */
let ownerSql: ReturnType<typeof postgres> | null = null;
function conexionDelDueno() {
  ownerSql ??= postgres(env.databaseUrl, { max: 1, onnotice: () => {} });
  return ownerSql;
}

/** El usuario con el que la app se conecta, sacado de la propia URL que usa. */
function rolDeLaApp(): string | null {
  try {
    const u = new URL(env.appDatabaseUrl).username;
    return u ? decodeURIComponent(u) : null;
  } catch {
    return null;
  }
}

/** El usuario dueño, para poder comparar y no actuar si son el mismo. */
function rolDueno(): string | null {
  try {
    const u = new URL(env.databaseUrl).username;
    return u ? decodeURIComponent(u) : null;
  } catch {
    return null;
  }
}

export interface Recuperacion {
  /** Cuántas transacciones colgadas se deshicieron. */
  terminadas: number;
  /** Los pid afectados, para que el aviso diga exactamente qué se tocó. */
  pids: number[];
}

export async function recuperarTransaccionesColgadas(
  /**
   * Solo los tests lo pasan, igual que en el watchdog de `db-scope`. Es un parámetro y no una
   * variable de entorno a propósito: el orden de las tres redes (Postgres 60 s → watchdog 90 s →
   * esta 120 s) es una decisión de diseño con un test que lo fija, no algo que convenga aflojar
   * desde un panel.
   */
  umbralSeg: number = UMBRAL_MATAR_SEG,
): Promise<Recuperacion> {
  const app = rolDeLaApp();
  const dueno = rolDueno();

  /*
   * Sin poder distinguir los roles, no se actúa. Ver la cabecera: una migración entre sentencias
   * también está `idle in transaction`, así que con un solo rol esta capa podría deshacer un
   * cambio de esquema a medias — mucho peor que la caída que viene a evitar.
   */
  if (!app || app === dueno) {
    return { terminadas: 0, pids: [] };
  }

  /*
   * ⚠️ LA SUBCONSULTA CON `offset 0` NO ES ESTILO: ES LO QUE IMPIDE QUE ESTO SEA CATASTRÓFICO.
   *
   * **Postgres no garantiza el orden de evaluación de las condiciones de un `WHERE`.** Escrito
   * como una sola lista de condiciones —que es la forma obvia y la que tenía la primera
   * versión— el planificador puede evaluar `pg_terminate_backend(pid)` ANTES de los filtros, y
   * entonces la función se ejecuta sobre filas que no pasaron ningún candado.
   *
   * MEDIDO contra Postgres real, en una base recién levantada: con la versión sin valla, el
   * filtro seleccionaba **0 filas** y aun así la consulta terminó su propia conexión
   * (`CONNECTION_CLOSED`). En producción eso habría cerrado TODO —el pool de la app, el rol
   * dueño, lo que hubiera— **cada dos minutos**: la capa escrita para prevenir la caída la
   * habría provocado sola, y con la firma de un misterio imposible de atribuir.
   *
   * `offset 0` es una valla de optimización: impide que el planificador aplane la subconsulta
   * en la consulta externa, así que los candados se aplican COMPLETOS antes de que
   * `pg_terminate_backend` vea un solo pid. Verificado: con la valla, 0 filas → 0 terminadas y
   * la conexión intacta.
   *
   * Y sigue siendo UNA sola consulta a propósito. Hacerlo en dos pasos —leer los pid, después
   * actuar— abriría una ventana en la que una sesión pasa de `idle in transaction` a `active`
   * entre una consulta y la otra, y ahí sí se interrumpiría trabajo real.
   *
   * `pid <> pg_backend_pid()` es defensa en profundidad: el filtro por `usename` ya excluye a
   * esta conexión (corre con el rol dueño), pero si alguien cambia ese filtro, esta condición
   * evita que la capa se alcance a sí misma.
   */
  const filas = await conexionDelDueno()<{ pid: number }[]>`
    select pid from (
      select pid
        from pg_stat_activity
       where usename = ${app}
         and state = 'idle in transaction'
         and now() - state_change > make_interval(secs => ${umbralSeg})
         and pid <> pg_backend_pid()
       offset 0
    ) colgadas
    where pg_terminate_backend(colgadas.pid)
  `;
  return { terminadas: filas.length, pids: filas.map((f) => f.pid) };
}
