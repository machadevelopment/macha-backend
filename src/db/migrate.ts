/**
 * Applies hand-written raw SQL migrations in src/db/migrations in filename order.
 * drizzle-kit generated files (if any) are plain .sql too and run in the same order.
 * Idempotency is the responsibility of each file (IF NOT EXISTS / guarded DO blocks).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';

const dir = join(dirname(fileURLToPath(import.meta.url)), 'migrations');
const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is not set');

const sql = postgres(url, { max: 1 });

const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
for (const f of files) {
  const body = readFileSync(join(dir, f), 'utf8');
  process.stdout.write(`applying ${f} ... `);
  await sql.unsafe(body);
  console.log('ok');
}
await sql.end();
console.log(`done (${files.length} migrations).`);
