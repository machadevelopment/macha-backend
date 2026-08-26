import { sql } from '@/db/client';

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * AVISAR ANTES DE QUE EL DISCO SE LLENE, NO DESPUÉS
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *
 * El 2026-08-26 la base de producción se cayó por disco lleno: 479,9 MB de un volumen de 500.
 * Postgres arrancaba, intentaba recuperar el WAL, no podía escribir y se apagaba — en bucle
 * durante una hora.
 *
 *     FATAL: could not write to file "pg_wal/xlogtemp.59": No space left on device
 *
 * Lo que hizo falta no fue arreglarlo más rápido: fue no llegar ahí. Railway avisa cuando el
 * servicio YA se cayó ("Deploy Crashed!"), y a esa altura la contabilidad de los clientes está
 * inaccesible y el arreglo —agrandar el volumen— es manual y de dashboard.
 *
 * Esto engancha en el backup nocturno, que ya corre todos los días y ya toca la base.
 *
 * ═══ QUÉ MIDE, Y QUÉ NO — LA LIMITACIÓN IMPORTA ═══
 *
 * `pg_database_size()` da el tamaño LÓGICO de la base. **No incluye el WAL**, que es
 * justamente lo que desbordó el volumen aquella vez: el `pg_wal` del incidente tenía una cola
 * de hasta 216 MB configurada, o sea el 43 % de aquel volumen de 500 MB.
 *
 * O sea que este número es una COTA INFERIOR de lo que el volumen tiene ocupado, no la cifra
 * exacta. Se dice acá para que nadie lea el aviso como una medición del disco.
 *
 * Sigue sirviendo, y por dos razones: el WAL crece con la actividad —así que una base grande
 * arrastra un WAL grande— y el umbral por defecto deja margen suficiente para cubrir esa
 * diferencia. Lo que este chequeo NO puede hacer es detectar un WAL que se dispara solo, por
 * una réplica trabada o un backup que no drena.
 *
 * El backend no puede medir el disco de verdad, y no es un descuido: el volumen pertenece al
 * servicio de Postgres, que es otro contenedor. Desde acá solo se ve la base, no su filesystem.
 *
 * ═══ EL LÍMITE SE CONFIGURA, PORQUE EL CÓDIGO NO PUEDE SABERLO ═══
 *
 * Railway inyecta `RAILWAY_VOLUME_NAME` y `RAILWAY_VOLUME_MOUNT_PATH` en el servicio que monta
 * el volumen, pero nunca su TAMAÑO, y de todos modos esas variables van al contenedor de
 * Postgres y no acá. Así que el límite viaja como variable de entorno.
 *
 * Sin ella el chequeo **no se apaga**: reporta el tamaño igual y solo se salta la comparación.
 * Un chequeo que se desactiva solo cuando falta configuración es un chequeo que un día no está
 * y nadie lo nota — que es exactamente cómo se llega a un disco lleno por sorpresa.
 */

/** Porcentaje de ocupación a partir del cual el aviso deja de ser informativo. */
const UMBRAL_AVISO = 0.75;

export interface TamanoDeBase {
  bytes: number;
  /** Límite del volumen, si está configurado. */
  limiteBytes: number | null;
  /** Ocupación 0–1 contra el límite. `null` cuando no hay límite configurado. */
  proporcion: number | null;
  /** `true` cuando conviene actuar ANTES de que el volumen se llene. */
  requiereAtencion: boolean;
  /** Las tablas más pesadas, para que el aviso diga QUÉ creció. */
  mayores: { tabla: string; bytes: number }[];
}

/** El límite del volumen en bytes, o `null` si no está configurado. */
function limiteConfigurado(): number | null {
  const raw = process.env.POSTGRES_VOLUME_LIMIT_MB;
  if (!raw) return null;
  const mb = Number(raw);
  return Number.isFinite(mb) && mb > 0 ? mb * 1024 * 1024 : null;
}

/**
 * Cuánto ocupa la base, y qué tablas lo explican.
 *
 * Las cinco tablas más pesadas van en el aviso porque sin ellas la alerta es un número sin
 * acción: saber que la base pesa 1,6 GB no dice qué hacer, y saber que 900 MB de eso son
 * `staging_rows` sí — esa tabla guarda el payload de cada fila de Excel YA promovida y hoy no
 * la limpia nadie.
 */
export async function medirTamanoDeBase(): Promise<TamanoDeBase> {
  const [fila] = await sql<{ bytes: string }[]>`
    SELECT pg_database_size(current_database())::text AS bytes
  `;
  const bytes = Number(fila?.bytes ?? 0);

  /*
   * `pg_total_relation_size` incluye índices y TOAST, que es lo que de verdad ocupa el disco —
   * `pg_relation_size` a secas deja fuera los índices, y en estas tablas los índices son una
   * fracción grande del total.
   *
   * Se listan solo tablas del esquema público: `pg_catalog` y las tablas internas de pg-boss no
   * son algo sobre lo que nadie vaya a actuar.
   */
  const mayores = await sql<{ tabla: string; bytes: string }[]>`
    SELECT c.relname AS tabla,
           pg_total_relation_size(c.oid)::text AS bytes
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relkind IN ('r', 'p')
     ORDER BY pg_total_relation_size(c.oid) DESC
     LIMIT 5
  `;

  const limiteBytes = limiteConfigurado();
  const proporcion = limiteBytes === null ? null : bytes / limiteBytes;

  return {
    bytes,
    limiteBytes,
    proporcion,
    requiereAtencion: proporcion !== null && proporcion >= UMBRAL_AVISO,
    mayores: mayores.map((m) => ({ tabla: m.tabla, bytes: Number(m.bytes) })),
  };
}

const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

/**
 * El aviso en palabras, para el log y para Sentry.
 *
 * Dice el tamaño, la proporción y las tablas que lo explican — y nombra la limitación, porque
 * un aviso que se lee como "el disco está al 78 %" cuando en realidad mide otra cosa es peor
 * que no tenerlo.
 */
export function describirTamano(t: TamanoDeBase): string {
  const cabeza =
    t.proporcion === null
      ? `la base ocupa ${mb(t.bytes)} (sin POSTGRES_VOLUME_LIMIT_MB configurado, no hay contra qué compararlo)`
      : `la base ocupa ${mb(t.bytes)} de ${mb(t.limiteBytes!)} del volumen (${(t.proporcion * 100).toFixed(0)} %), SIN CONTAR el WAL`;

  const detalle = t.mayores.map((m) => `${m.tabla} ${mb(m.bytes)}`).join(' · ');
  return detalle ? `${cabeza}. Lo más pesado: ${detalle}` : cabeza;
}
