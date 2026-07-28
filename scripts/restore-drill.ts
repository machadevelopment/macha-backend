/**
 * CU-868kfvata — simulacro de restauración: descarga el dump más reciente de S3
 * (backups/postgres/, subido por el job nocturno de CU-868kfvar3) y lo restaura
 * contra un Postgres de VERIFICACIÓN, nunca contra DATABASE_URL de este proceso.
 *
 * Uso:
 *   RESTORE_TARGET_DATABASE_URL=postgres://... bun run scripts/restore-drill.ts
 *
 * RESTORE_TARGET_DATABASE_URL es obligatorio y deliberadamente NO cae a
 * env.databaseUrl — un simulacro que sobreescribe la base real (dev, staging o
 * peor, prod) por un typo de configuración sería el peor resultado posible de
 * "verificar que los backups sirven". Apunta esto a una instancia Postgres
 * desechable (contenedor local, DB de un solo uso en Railway), nunca a un
 * ambiente real.
 *
 * Al terminar, corre un par de queries de sanity check (conteo de filas en tablas
 * clave) y las imprime — pega el resultado en el comentario de ClickUp del ticket
 * junto con la fecha, como registro del simulacro mensual (criterio 2/3).
 */
import { listObjects, downloadObject } from '../src/lib/s3';

async function main() {
  const targetUrl = process.env.RESTORE_TARGET_DATABASE_URL;
  if (!targetUrl) {
    console.error(
      'RESTORE_TARGET_DATABASE_URL no está seteada. Apúntala a un Postgres DESECHABLE de verificación, nunca a un ambiente real, y vuelve a correr.',
    );
    process.exit(1);
  }

  console.log('Buscando el dump más reciente en backups/postgres/...');
  const objects = await listObjects('backups/postgres/');
  if (objects.length === 0) {
    console.error('No hay ningún backup en S3 bajo backups/postgres/ — nada que restaurar.');
    process.exit(1);
  }
  const latest = objects.sort((a, b) => b.lastModified.getTime() - a.lastModified.getTime())[0]!;
  console.log(`Backup más reciente: ${latest.key} (${latest.lastModified.toISOString()})`);

  const dump = await downloadObject(latest.key);
  const tmpPath = `/tmp/restore-drill-${Date.now()}.dump`;
  await Bun.write(tmpPath, dump);
  console.log(`Descargado a ${tmpPath} (${dump.byteLength} bytes). Restaurando...`);

  const restoreProc = Bun.spawn(
    ['pg_restore', '--clean', '--if-exists', '--no-owner', '--no-acl', '-d', targetUrl, tmpPath],
    { stdout: 'inherit', stderr: 'inherit' },
  );
  const restoreExit = await restoreProc.exited;
  if (restoreExit !== 0) {
    console.error(`pg_restore salió con código ${restoreExit} — simulacro FALLIDO.`);
    process.exit(1);
  }

  console.log('\nRestauración completada. Sanity check:');
  const checkProc = Bun.spawn(
    [
      'psql',
      targetUrl,
      '-c',
      "select 'companies' as tabla, count(*) from companies union all select 'transactions', count(*) from transactions union all select 'ai_usage_events', count(*) from ai_usage_events;",
    ],
    { stdout: 'inherit', stderr: 'inherit' },
  );
  const checkExit = await checkProc.exited;
  if (checkExit !== 0) {
    console.error(
      'El sanity check post-restore falló — revisar manualmente antes de dar el simulacro por bueno.',
    );
    process.exit(1);
  }

  console.log(`\nSimulacro OK — ${new Date().toISOString()}. Backup restaurado: ${latest.key}.`);
}

main().catch((err) => {
  console.error('Simulacro de restauración falló:', err);
  process.exit(1);
});
