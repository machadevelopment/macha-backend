/**
 * CU-868kjbw5h criterios 3 y 4 — verifica contra una instancia REAL que el aislamiento
 * ahora muerde. No prueba políticas por separado: ejercita las dos garantías que el
 * proyecto declara no negociables, con el rol con el que la app conecta de verdad.
 *
 * Uso (staging primero; producción es un paso aparte, FRENO 3 — lo corre el dueño):
 *   VERIFY_OWNER_DATABASE_URL=postgres://owner@...  \
 *   VERIFY_APP_DATABASE_URL=postgres://macha_app@... \
 *   bun run verify:isolation
 *
 * Ninguna de las dos cae a DATABASE_URL a propósito (mismo motivo que restore-drill.ts y
 * audit-staging-data.ts): apúntalas explícitamente, nunca corras esto contra lo que sea
 * que DATABASE_URL valga en ese momento.
 *
 * Es de solo lectura. El único UPDATE que intenta va dentro de una transacción que se
 * revierte siempre, y su éxito sería el fallo que buscamos.
 */
import postgres from 'postgres';
import { evaluateIsolation, type RoleFacts } from '@/lib/db-role-check';

/** Los 6 ledgers append-only de CLAUDE.md. Ninguno debe aceptar UPDATE. */
const LEDGERS = [
  'ai_usage_events',
  'credit_transactions',
  'admin_audit_log',
  'report_versions',
  'industry_template_versions',
  'payments',
] as const;

/** SQLSTATE de Postgres para "permiso denegado" — el único error que cuenta como éxito. */
const INSUFFICIENT_PRIVILEGE = '42501';

let failures = 0;

function ok(msg: string): void {
  console.log(`  ✅ ${msg}`);
}

function fail(msg: string): void {
  failures += 1;
  console.error(`  ❌ ${msg}`);
}

async function main(): Promise<void> {
  const ownerUrl = process.env.VERIFY_OWNER_DATABASE_URL;
  const appUrl = process.env.VERIFY_APP_DATABASE_URL;
  if (!ownerUrl || !appUrl) {
    console.error(
      'Faltan VERIFY_OWNER_DATABASE_URL y/o VERIFY_APP_DATABASE_URL. Apúntalas explícitamente ' +
        '(la primera al rol dueño, la segunda a macha_app) y vuelve a correr.',
    );
    process.exit(1);
  }

  const owner = postgres(ownerUrl, { max: 1 });
  const app = postgres(appUrl, { max: 1 });

  try {
    await checkPreconditions(app);
    await checkAppendOnly(app);
    await checkTenantIsolation(owner, app);
  } finally {
    await owner.end();
    await app.end();
  }

  console.log('');
  if (failures > 0) {
    console.error(
      `${failures} verificación(es) fallaron. El aislamiento NO está activo — no marques ` +
        'los criterios 3/4 ni setees REQUIRE_ISOLATED_DB_ROLE=true todavía.',
    );
    process.exit(1);
  }
  console.log(
    'Aislamiento verificado contra la instancia real. Siguiente paso: setear ' +
      'REQUIRE_ISOLATED_DB_ROLE=true en este entorno para que una regresión de ' +
      'configuración aborte el arranque en vez de degradarse en silencio.',
  );
}

/** Criterio 3 (parte de rol): la app conecta con un rol que no puede saltarse nada. */
async function checkPreconditions(app: postgres.Sql): Promise<void> {
  console.log('Precondiciones del rol de la aplicación');

  const [user] = await app<{ current_user: string }[]>`select current_user`;
  const owned = await app<{ tablename: string }[]>`
    select tablename from pg_tables
    where schemaname = 'public' and tableowner = current_user
    limit 3
  `;
  const [role] = await app<{ rolsuper: boolean; rolbypassrls: boolean }[]>`
    select rolsuper, rolbypassrls from pg_roles where rolname = current_user
  `;

  const facts: RoleFacts = {
    role: user?.current_user ?? 'desconocido',
    ownedTables: owned.map((r) => r.tablename),
    isSuperuser: role?.rolsuper ?? false,
    bypassesRls: role?.rolbypassrls ?? false,
    // Aquí siempre es explícita: la exige este script. La bandera existe para el
    // preflight de arranque, no para esta comprobación.
    appUrlIsExplicit: true,
  };

  const verdict = evaluateIsolation(facts);
  if (verdict.isolated) {
    ok(`conecta como '${verdict.role}': no es dueño, no es superuser, no tiene BYPASSRLS`);
  } else {
    for (const reason of verdict.reasons) fail(reason);
  }
}

/** Criterio 4, primera mitad: UPDATE sobre los 6 ledgers debe fallar por privilegios. */
async function checkAppendOnly(app: postgres.Sql): Promise<void> {
  console.log('\nAppend-only: UPDATE debe ser rechazado en los 6 ledgers');

  for (const table of LEDGERS) {
    try {
      // `where false` no toca ninguna fila, pero Postgres verifica el privilegio igual,
      // al planificar. La transacción se revierte pase lo que pase.
      await app.begin(async (tx) => {
        await tx.unsafe(`update ${table} set id = id where false`);
        throw new Error(`__rollback__:${table}`);
      });
      fail(`${table}: el UPDATE fue ACEPTADO — el append-only no está activo`);
    } catch (err) {
      const code = (err as { code?: string }).code;
      const message = (err as { message?: string }).message ?? '';
      if (code === INSUFFICIENT_PRIVILEGE) {
        ok(`${table}: UPDATE rechazado (permiso denegado)`);
      } else if (message.startsWith('__rollback__:')) {
        fail(`${table}: el UPDATE fue ACEPTADO — el append-only no está activo`);
      } else {
        // Un error distinto (p. ej. columna inexistente) NO es una verificación exitosa:
        // no probaría nada sobre privilegios y dejaría pasar el fallo real.
        fail(`${table}: error inesperado (${code ?? 'sin código'}): ${message}`);
      }
    }
  }
}

/** Criterio 4, segunda mitad: una sesión con la empresa A no ve filas de la B. */
async function checkTenantIsolation(owner: postgres.Sql, app: postgres.Sql): Promise<void> {
  console.log('\nAislamiento por empresa: RLS debe ocultar las filas de la otra empresa');

  // Las company_id se enumeran con el rol dueño: el de la app no puede verlas sin haber
  // seteado antes el GUC, que es justo lo que aquí se quiere probar.
  const companies = await owner<{ company_id: string; n: number }[]>`
    select company_id, count(*)::int as n from documents group by company_id
    having count(*) > 0 order by n desc limit 2
  `;

  if (companies.length < 2) {
    fail(
      'no hay dos empresas con documentos en esta base: el criterio 4 no se puede verificar ' +
        'aquí. Carga datos sintéticos de dos empresas y vuelve a correr.',
    );
    return;
  }

  const a = companies[0]!;
  const b = companies[1]!;

  await app.begin(async (tx) => {
    // Los dos GUC de la migración 0012: la política de `documents` lee app.company_id.
    await tx`select set_config('app.company_id', ${a.company_id}, true)`;

    const [visible] = await tx<{ n: number }[]>`select count(*)::int as n from documents`;
    const [otra] = await tx<{ n: number }[]>`
      select count(*)::int as n from documents where company_id = ${b.company_id}
    `;

    if (otra?.n === 0) {
      ok(
        `con app.company_id=${a.company_id.slice(0, 8)}… no se ve ninguna fila de la otra empresa`,
      );
    } else {
      fail(`se ven ${otra?.n} filas de la empresa ${b.company_id} — RLS NO está aislando`);
    }

    // Contraprueba: si tampoco ve las suyas, el 0 de arriba no probaba aislamiento sino
    // una conexión que no ve nada (permisos mal dados, GUC que no aplica).
    if (visible?.n === a.n) {
      ok(`sí ve las ${visible?.n} filas de su propia empresa (el 0 anterior es RLS, no ceguera)`);
    } else {
      fail(
        `ve ${visible?.n} filas propias pero el dueño cuenta ${a.n}: revisa GRANTs o políticas ` +
          'antes de dar el aislamiento por bueno',
      );
    }
  });
}

main().catch((err) => {
  console.error('La verificación de aislamiento falló:', err);
  process.exit(1);
});
