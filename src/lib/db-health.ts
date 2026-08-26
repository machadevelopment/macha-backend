import { sql } from '@/db/client';

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
 * De ahí las dos piezas que este archivo habilita: un chequeo que SÍ mira el pool
 * (`/health/db`, para que Railway pueda reiniciar el servicio solo) y un job periódico que
 * avisa antes de que el usuario lo note.
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
