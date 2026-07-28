import { env } from './env';
import { uploadObject, listObjects, deleteObject } from './s3';

const BACKUP_PREFIX = 'backups/postgres/';

/**
 * CU-868kfvar3: segunda capa de respaldo (la primera es el backup nativo de
 * Railway, config de consola — fuera de alcance de código). pg_dump corre contra
 * DATABASE_URL (rol owner) — un dump completo necesita ver todo, no tiene sentido
 * correrlo como macha_app. Formato -Fc (custom, ya comprimido) en vez de un dump de
 * texto plano + gzip aparte.
 */
export async function runDatabaseBackup(): Promise<{ key: string; sizeBytes: number }> {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const key = `${BACKUP_PREFIX}${timestamp}.dump`;

  const proc = Bun.spawn(
    ['pg_dump', env.databaseUrl, '--format=custom', '--no-owner', '--no-acl'],
    {
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );
  const [dump, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).arrayBuffer(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`pg_dump exited with code ${exitCode}: ${stderr}`);
  }

  const body = new Uint8Array(dump);
  await uploadObject(key, body, 'application/octet-stream');
  await pruneOldBackups();
  return { key, sizeBytes: body.byteLength };
}

/** Pure decision logic (kept separate from the S3 calls so it's testable without a
 * real bucket) — an object is expired once it's older than retentionDays. */
export function filterExpired(
  objects: Array<{ key: string; lastModified: Date }>,
  retentionDays: number,
  now: Date = new Date(),
): Array<{ key: string; lastModified: Date }> {
  const cutoff = now.getTime() - retentionDays * 24 * 60 * 60 * 1000;
  return objects.filter((o) => o.lastModified.getTime() < cutoff);
}

/** Retention: deletes dump objects older than env.backupRetentionDays (default 30). */
export async function pruneOldBackups(): Promise<string[]> {
  const objects = await listObjects(BACKUP_PREFIX);
  const expired = filterExpired(objects, env.backupRetentionDays);
  await Promise.all(expired.map((o) => deleteObject(o.key)));
  return expired.map((o) => o.key);
}
