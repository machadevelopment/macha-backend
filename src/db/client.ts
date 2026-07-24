import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is not set');

// Single shared postgres-js connection. Tenant scoping is enforced in guards;
// RLS reads app.company_id GUC set per request (see guards/tenant.derive.ts).
export const sql = postgres(connectionString, { max: 10 });
export const db = drizzle(sql, { schema });
export type DB = typeof db;
export { schema };
