import { getRedis } from './redis';
import { sql } from '@/db/client';
import { rateLimitConfig } from '@/config/rate-limit';
import { QUEUES } from '@/queue';

// CU-868kfvaah: implementa los dos mecanismos confirmados en CU-868kfv97f (valores
// reales, ver src/config/rate-limit.ts).
//
// Estado real de consumo (verificado en la auditoría del 2026-07-28 — el comentario
// anterior decía que ninguna ruta consumía el token-bucket, lo cual quedó obsoleto
// cuando F4/F5 se implementaron):
// - `checkQueueGate`: EN USO por el intake de Excel (CU-868kfva89).
// - `checkTokenBucket('ai')`: EN USO por chat (modules/chats) e insight
//   (modules/insights).
// - `checkTokenBucket('read')`: CONFIGURADO PERO SIN CONSUMIDORES. Ninguna ruta de
//   lectura (dashboard, /metrics, /ar-ap, polling de estado) lo aplica todavía, así
//   que la API de lectura general no tiene rate limiting real. Tiene ticket propio.

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

/** 429 + Retry-After en el bucket agotado (respuesta acordada con Jose, CU-868kfv97f). */
export async function checkTokenBucket(
  bucket: TokenBucketName,
  companyId: string,
): Promise<{ allowed: boolean; retryAfterSeconds: number }> {
  const { rpm, burst } = rateLimitConfig.tokenBucket[bucket];
  const refillPerMs = rpm / 60_000;
  const now = Date.now();

  const [allowed, tokensLeft] = (await getRedis().eval(
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
