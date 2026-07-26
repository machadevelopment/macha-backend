import Redis from 'ioredis';
import { env } from './env';

// Single shared connection for rate limiting (CU-868kfvaah). No other subsystem uses
// Redis in this repo — keep it that way; anything durable belongs in Postgres.
let redis: Redis | undefined;
export function getRedis(): Redis {
  redis ??= new Redis(env.redisUrl, { maxRetriesPerRequest: 2 });
  return redis;
}
