import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { env } from '@/lib/env';
import * as schema from './schema';

// Runtime connection uses the restricted macha_app role (env.appDatabaseUrl,
// migration 0010), NOT the owner role that runs migrations — a table owner always
// bypasses REVOKE UPDATE/DELETE in Postgres, so the append-only ledger guarantee
// only holds for a role that never owns the tables. Falls back to DATABASE_URL
// until an operator provisions the real Railway role (see env.ts).
// Tenant scoping is enforced in guards; RLS reads app.company_id GUC set per
// request (see guards/tenant.derive.ts) and is FORCE-applied (migration 0010) so
// it also holds for this connection even though it may still be the owner locally.
export const sql = postgres(env.appDatabaseUrl, { max: 10 });
export const db = drizzle(sql, { schema });
export type DB = typeof db;
export { schema };
