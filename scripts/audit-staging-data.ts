/**
 * CU-868kfvaz6 — ayuda a verificar que staging opera únicamente con datos
 * sintéticos (criterio 2: "nunca se copian datos de producción"). No puede
 * confirmarlo por sí solo — "es sintético" es un juicio humano sobre el
 * contenido real — pero lista lo que hay que revisar en un solo lugar en vez de
 * hacer SQL ad-hoc cada vez.
 *
 * Uso:
 *   AUDIT_TARGET_DATABASE_URL=postgres://... bun run audit:staging-data
 *
 * AUDIT_TARGET_DATABASE_URL es obligatoria y NO cae a DATABASE_URL a propósito
 * (mismo motivo que restore-drill.ts) — apúntala explícitamente a staging, nunca
 * corras esto sin pensar contra el ambiente que sea DATABASE_URL en ese momento.
 */

async function main() {
  const targetUrl = process.env.AUDIT_TARGET_DATABASE_URL;
  if (!targetUrl) {
    console.error(
      'AUDIT_TARGET_DATABASE_URL no está seteada. Apúntala explícitamente a staging y vuelve a correr.',
    );
    process.exit(1);
  }

  console.log('Empresas en este ambiente (revisa nombre/industry — ¿se ven sintéticas?):');
  await psql(
    targetUrl,
    'select id, name, industry, status, created_at from companies order by created_at;',
  );

  console.log(
    '\nDominios de email distintos entre los usuarios (¿alguno es un dominio real de cliente?):',
  );
  await psql(
    targetUrl,
    "select split_part(email, '@', 2) as domain, count(*) from users group by domain order by count(*) desc;",
  );

  console.log('\nConteo de filas de negocio (¿el volumen es consistente con datos de prueba?):');
  await psql(
    targetUrl,
    "select 'transactions' as tabla, count(*) from transactions union all select 'invoices', count(*) from invoices union all select 'bills', count(*) from bills union all select 'documents', count(*) from documents;",
  );

  console.log(
    '\nRevisión manual requerida — este script no puede confirmar "es sintético" por sí solo. Registra el resultado en el ticket de ClickUp.',
  );
}

async function psql(targetUrl: string, query: string): Promise<void> {
  const proc = Bun.spawn(['psql', targetUrl, '-c', query], {
    stdout: 'inherit',
    stderr: 'inherit',
  });
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    console.error(`psql salió con código ${exitCode} para: ${query}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Auditoría de datos de staging falló:', err);
  process.exit(1);
});
