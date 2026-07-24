import type { Config } from 'drizzle-kit';

export default {
  schema: './src/db/schema/index.ts',
  out: './src/db/migrations',
  dialect: 'postgresql',
  dbCredentials: { url: process.env.DATABASE_URL! },
  // Raw SQL (partitions, RLS, CHECKs, partial indexes, REVOKE) lives in
  // hand-written migration files — drizzle-kit does not generate those.
  verbose: true,
  strict: true,
} satisfies Config;
