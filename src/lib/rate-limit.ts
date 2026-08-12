import * as Sentry from '@sentry/bun';
import { t, type Context } from 'elysia';
import { getRedis } from './redis';
import { sql } from '@/db/client';
import { rateLimitConfig } from '@/config/rate-limit';
import { QUEUES } from '@/queue';

// CU-868kfvaah: implementa los dos mecanismos confirmados en CU-868kfv97f (valores
// reales, ver src/config/rate-limit.ts).
//
// Estado real de consumo (actualizado en CU-868kh8qhp):
// - `checkQueueGate`: EN USO por el intake de Excel (CU-868kfva89) y, desde la
//   generación a demanda de reportes, también con `report_generation`
//   (POST /reports/generate). CU-868kjby4z: los dos kinds declarados en
//   `queueGate.appliesTo` tienen consumidor; el fan-out del sistema (`report-tick`)
//   queda fuera a propósito — ver el porqué en config/rate-limit.ts.
// - `checkTokenBucket('ai')`: EN USO por chat (modules/chats) e insight
//   (modules/insights).
// - `checkTokenBucket('read')`: EN USO por las rutas de lectura tenant-scoped
//   (/metrics, /ar-ap, /documents, /reports, /credits/balance) vía
//   `enforceTokenBucket`. Hasta CU-868kh8qhp estaba configurado sin consumidores y
//   la API de lectura no tenía rate limiting real.
//
// `/admin/*` queda DELIBERADAMENTE fuera del bucket `read`: es staff, no tenant, y
// los buckets se llavean por company_id — no hay company_id que llavear ahí. Limitar
// al backoffice es una decisión distinta y necesitaría su propio criterio.

// Token-bucket atómico (Lua): evita condiciones de carrera en refill/consumo bajo
// concurrencia — leer+escribir en dos pasos desde el cliente no sería atómico.
const TOKEN_BUCKET_LUA = `
local key = KEYS[1]
local capacity = tonumber(ARGV[1])
local refill_per_ms = tonumber(ARGV[2])
local now = tonumber(ARGV[3])
local requested = tonumber(ARGV[4])

local bucket = redis.call('HMGET', key, 'tokens', 'ts')
local tokens = tonumber(bucket[1])
local ts = tonumber(bucket[2])

if tokens == nil then
  tokens = capacity
  ts = now
end

local elapsed = math.max(0, now - ts)
tokens = math.min(capacity, tokens + elapsed * refill_per_ms)

local allowed = 0
if tokens >= requested then
  allowed = 1
  tokens = tokens - requested
end

redis.call('HMSET', key, 'tokens', tokens, 'ts', now)
redis.call('EXPIRE', key, 86400)

return { allowed, tokens }
`;

export type TokenBucketName = keyof typeof rateLimitConfig.tokenBucket;

/**
 * Lo único que este módulo necesita de Redis. Se inyecta (con default al cliente
 * real) para que el test del bucket agotado —criterio 3 de CU-868kh8qhp— pueda
 * ejercitar la rama de rechazo sin un Redis vivo y sin `mock.module`, que es global
 * al proceso de `bun test` y se filtraría a los demás archivos de test.
 */
export type TokenBucketRedis = Pick<ReturnType<typeof getRedis>, 'eval'>;

/** 429 + Retry-After en el bucket agotado (respuesta acordada con Jose, CU-868kfv97f). */
export async function checkTokenBucket(
  bucket: TokenBucketName,
  companyId: string,
  redis: TokenBucketRedis = getRedis(),
): Promise<{ allowed: boolean; retryAfterSeconds: number }> {
  const { rpm, burst } = rateLimitConfig.tokenBucket[bucket];
  const refillPerMs = rpm / 60_000;
  const now = Date.now();

  const [allowed, tokensLeft] = (await redis.eval(
    TOKEN_BUCKET_LUA,
    1,
    `rl:${bucket}:${companyId}`,
    burst,
    refillPerMs,
    now,
    1,
  )) as [number, number];

  if (allowed === 1) return { allowed: true, retryAfterSeconds: 0 };

  const deficitMs = (1 - tokensLeft) / refillPerMs;
  return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil(deficitMs / 1000)) };
}

type GateKind = (typeof rateLimitConfig.queueGate.appliesTo)[number];

const GATE_QUEUE_NAME: Record<GateKind, string> = {
  excel: QUEUES.excelIngest,
  report_generation: QUEUES.reportGenerate,
};

/**
 * Gate de profundidad de cola: solo `excel`/`report_generation` pasan por aquí
 * (chat/insight quedan explícitamente fuera, ver rate-limit.ts). Lee las tablas
 * propias de pg-boss (schema `pgboss`, default de esta instancia) — sin tabla propia
 * de rate limiting, tal como pide data model.md §18.
 *
 * Acepta también `chat`/`insight` y devuelve `allowed` sin consultar nada: así una
 * ruta interactiva puede llamarlo sin ramificar, y el criterio de qué se gatea vive
 * en un solo lugar (`queueGate.appliesTo`) en vez de repartido por los llamadores.
 */
export async function checkQueueGate(
  companyId: string,
  kind: 'excel' | 'chat' | 'insight' | 'report_generation',
): Promise<{ allowed: boolean; activeCount: number }> {
  if (kind !== 'excel' && kind !== 'report_generation') {
    return { allowed: true, activeCount: 0 };
  }

  const queueName = GATE_QUEUE_NAME[kind];
  const [row] = await sql<{ count: number }[]>`
    select count(*)::int as count
    from pgboss.job
    where name = ${queueName}
      and state in ('created', 'retry', 'active')
      and data ->> 'companyId' = ${companyId}
  `;
  const activeCount = row?.count ?? 0;
  return { allowed: activeCount < rateLimitConfig.queueGate.maxJobs, activeCount };
}

// ---------------------------------------------------------------------------
// Observabilidad de los 429 — CU-868kh92fz
// ---------------------------------------------------------------------------

export type RateLimitMechanism = 'token_bucket' | 'queue_gate';

/**
 * Registra en Sentry que se devolvió un 429. `config/rate-limit.ts` documentaba esto
 * como acordado con Jose (CU-868kfv97f) desde el principio, pero no existía: los tres
 * puntos que devuelven 429 lo hacen como valor de retorno normal, y el `onError`
 * global de `src/index.ts` no se dispara con eso. Un cliente topando el límite de
 * forma sostenida era invisible.
 *
 * Nivel `warning`, NO excepción (criterio 2): un rate limit que rechaza es el
 * mecanismo funcionando, no un fallo. Mandarlo al feed de errores lo volvería ruido y
 * acabaría ignorado — justo lo contrario de lo que el ticket busca.
 *
 * El mensaje agrupa por mecanismo + detalle (bucket o kind), y `company_id` va como
 * TAG, no en el mensaje: así Sentry agrupa los eventos en una sola entrada por
 * mecanismo y permite desglosar "qué empresas topan y con qué frecuencia" (criterio
 * 3). Si el company_id fuera parte del mensaje, cada empresa abriría su propio grupo
 * y la pregunta dejaría de ser contestable de un vistazo.
 *
 * No-op sin `SENTRY_DSN` (local/CI nunca lo setean), igual que el resto de
 * integraciones opcionales del repo — no agrega dependencias ni rompe los tests.
 */
export function reportRateLimited(event: {
  mechanism: RateLimitMechanism;
  companyId: string;
  /** Ruta lógica que rechazó, p. ej. 'GET /metrics'. */
  route: string;
  /** Bucket (`read`/`ai`) o kind de la cola (`excel`/`report_generation`). */
  detail: string;
}): void {
  Sentry.captureMessage(`rate_limited: ${event.mechanism} (${event.detail})`, {
    level: 'warning',
    tags: {
      rate_limit_mechanism: event.mechanism,
      rate_limit_detail: event.detail,
      company_id: event.companyId,
      route: event.route,
    },
  });
}

/** Cuerpo del 429 por token-bucket. Compartido para que las rutas lo validen igual. */
export const rateLimitedResponse = t.Object({
  error: t.Literal('rate_limited'),
  retryAfterSeconds: t.Number(),
});

export type RateLimitedBody = { error: 'rate_limited'; retryAfterSeconds: number };

/**
 * Aplica un token-bucket a una ruta: si rechaza, setea 429 + `Retry-After`, lo
 * registra en Sentry y devuelve el cuerpo del error; si permite, devuelve `null`.
 *
 * Existe para que "rechazar" y "reportar" no puedan separarse: antes cada ruta
 * copiaba las tres líneas del 429 a mano y ninguna reportaba. Se llama inline desde
 * el handler —igual que `assertClientCapability`— porque los genéricos de
 * `.guard()`/`.macro()` de esta versión de Elysia no enhebran de forma fiable el
 * `derive` del plugin de tenant hacia un `beforeHandle` suelto.
 */
export async function enforceTokenBucket(
  bucket: TokenBucketName,
  companyId: string,
  set: Context['set'],
  route: string,
  // Inyectable por la misma razón que en `checkTokenBucket`: sin esto la rama del 429
  // no se puede probar sin un Redis real, y el test solo podía comprobar que la función
  // existiera. Los cinco módulos que ya la llaman no cambian: es opcional y va al final.
  redis?: TokenBucketRedis,
): Promise<RateLimitedBody | null> {
  const gate = await checkTokenBucket(bucket, companyId, redis);
  if (gate.allowed) return null;

  set.status = 429;
  set.headers['Retry-After'] = String(gate.retryAfterSeconds);
  reportRateLimited({ mechanism: 'token_bucket', companyId, route, detail: bucket });
  return { error: 'rate_limited', retryAfterSeconds: gate.retryAfterSeconds };
}

/**
 * CU-868kjc950: variante con la clave por USUARIO, para las rutas donde todavía no hay
 * empresa a la que cobrarle el cupo — hoy solo `/register`, que cuelga de
 * `identityDerive` y no de `tenantDerive`.
 *
 * Se añade en vez de cambiar la firma de arriba (nota técnica del ticket): cinco módulos
 * ya llaman a `enforceTokenBucket(bucket, companyId, …)` y reescribirlos solo para
 * generalizar una clave es riesgo sin ganancia.
 *
 * El prefijo `u:` mantiene los dos espacios de nombres separados en Redis. Ambos ids son
 * UUID, así que sin él una empresa y un usuario podrían compartir cupo por accidente si
 * alguna vez se les asignara el mismo bucket.
 */
export async function enforceTokenBucketForUser(
  bucket: TokenBucketName,
  userId: string,
  set: Context['set'],
  route: string,
  redis?: TokenBucketRedis,
): Promise<RateLimitedBody | null> {
  const gate = await checkTokenBucket(bucket, `u:${userId}`, redis);
  if (gate.allowed) return null;

  set.status = 429;
  set.headers['Retry-After'] = String(gate.retryAfterSeconds);
  // `companyId` es el sujeto del reporte, no necesariamente una empresa: aquí es el
  // usuario, que es lo único que identifica a quien está agotando el cupo.
  reportRateLimited({ mechanism: 'token_bucket', companyId: `u:${userId}`, route, detail: bucket });
  return { error: 'rate_limited', retryAfterSeconds: gate.retryAfterSeconds };
}
