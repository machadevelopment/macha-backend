import postgres from 'postgres';
import * as Sentry from '@sentry/bun';

/**
 * CU-868kjbw5h — el aislamiento multi-tenant estaba construido, testeado y APAGADO.
 *
 * `env.appDatabaseUrl` cae a `DATABASE_URL` cuando `APP_DATABASE_URL` no está seteada,
 * y ese rol es el DUEÑO de las tablas. Para un dueño, `FORCE ROW LEVEL SECURITY` (0010)
 * sí aplica, pero `REVOKE UPDATE, DELETE` NO: Postgres le conserva esos privilegios de
 * forma implícita e irrevocable. O sea que la configuración por omisión deja el
 * append-only de los 6 ledgers como decoración, sin un solo error ni log que lo diga.
 *
 * Este módulo convierte ese fallo silencioso en uno ruidoso. Las mismas tres condiciones
 * que `tests/integration/preconditions.test.ts` exige en CI, verificadas contra la
 * conexión real en el arranque — porque hasta ahora lo que CI verificaba no era lo que
 * corría en staging ni en producción.
 */

type Sql = ReturnType<typeof postgres>;

/** Lo que se observa de la conexión viva. Separado del juicio para poder testearlo. */
export type RoleFacts = {
  role: string;
  /** Tablas de `public` cuyo dueño es el rol conectado (muestra, no exhaustivo). */
  ownedTables: string[];
  isSuperuser: boolean;
  bypassesRls: boolean;
  /** `APP_DATABASE_URL` venía seteada, o se cayó al fallback de `DATABASE_URL`. */
  appUrlIsExplicit: boolean;
};

export type IsolationVerdict = {
  isolated: boolean;
  role: string;
  reasons: string[];
};

/**
 * El juicio, sin I/O. Cada motivo describe qué garantía se pierde, no solo qué está mal:
 * el que lea este log en un arranque de producción necesita saber qué queda expuesto.
 */
export function evaluateIsolation(facts: RoleFacts): IsolationVerdict {
  const reasons: string[] = [];

  if (facts.ownedTables.length > 0) {
    const sample = facts.ownedTables.slice(0, 3).join(', ');
    reasons.push(
      `el rol '${facts.role}' es DUEÑO de tablas de public (${sample}…): Postgres le da ` +
        `UPDATE/DELETE implícitos e irrevocables, así que el REVOKE sobre los 6 ledgers ` +
        `append-only no aplica`,
    );
  }
  if (facts.isSuperuser) {
    reasons.push(`el rol '${facts.role}' es SUPERUSER: RLS se ignora por completo`);
  }
  if (facts.bypassesRls) {
    reasons.push(`el rol '${facts.role}' tiene BYPASSRLS: RLS se ignora por completo`);
  }
  if (!facts.appUrlIsExplicit) {
    reasons.push(
      'APP_DATABASE_URL no está seteada y se cayó a DATABASE_URL (el rol que corre las ' +
        'migraciones) — ver la cabecera de 0010_force_rls_and_app_role.sql',
    );
  }

  return { isolated: reasons.length === 0, role: facts.role, reasons };
}

/**
 * Las tres preguntas que `preconditions.test.ts` le hace a la base, contra la conexión real.
 *
 * `appUrlIsExplicit` entra por parámetro en vez de leerse de `env` aquí: así este módulo
 * no depende de la configuración del proceso y su lógica se puede probar sin `DATABASE_URL`.
 */
export async function readRoleFacts(sql: Sql, appUrlIsExplicit: boolean): Promise<RoleFacts> {
  const [user] = await sql<{ current_user: string }[]>`select current_user`;
  // LIMIT 3: solo hace falta saber SI posee alguna, no cuántas. Evita traer 30+ nombres
  // en el arranque cuando el fallback está activo (que es el caso hoy, todo el esquema).
  const owned = await sql<{ tablename: string }[]>`
    select tablename from pg_tables
    where schemaname = 'public' and tableowner = current_user
    limit 3
  `;
  const [role] = await sql<{ rolsuper: boolean; rolbypassrls: boolean }[]>`
    select rolsuper, rolbypassrls from pg_roles where rolname = current_user
  `;

  return {
    role: user?.current_user ?? 'desconocido',
    ownedTables: owned.map((r) => r.tablename),
    isSuperuser: role?.rolsuper ?? false,
    bypassesRls: role?.rolbypassrls ?? false,
    appUrlIsExplicit,
  };
}

/**
 * Preflight de arranque. NO aborta por omisión, a propósito: hoy ningún entorno tiene
 * el rol creado (es justo lo que este ticket destapa), así que un `exit(1)` incondicional
 * tumbaría staging en el próximo deploy en vez de arreglar nada.
 *
 * El orden de despliegue es: se ve el log/alerta → el operador crea el rol y setea
 * APP_DATABASE_URL (criterios 2-3) → verifica con `bun run verify:isolation` (criterio 4)
 * → **entonces** setea REQUIRE_ISOLATED_DB_ROLE=true, y a partir de ahí una regresión de
 * configuración deja de arrancar en vez de degradarse en silencio.
 */
export async function runStartupIsolationCheck(
  sql: Sql,
  opts: { appUrlIsExplicit: boolean; requireIsolated: boolean; nodeEnv: string },
): Promise<IsolationVerdict> {
  const verdict = evaluateIsolation(await readRoleFacts(sql, opts.appUrlIsExplicit));
  if (verdict.isolated) {
    console.log(`[db] aislamiento OK — la app conecta como '${verdict.role}' (no dueño).`);
    return verdict;
  }

  const detail = verdict.reasons.map((r) => `  - ${r}`).join('\n');
  const headline =
    'AISLAMIENTO DE BASE DE DATOS INACTIVO: RLS y/o append-only son no-ops para esta conexión.';
  console.error(`[db] ${headline}\n${detail}`);

  Sentry.captureMessage(`${headline} rol=${verdict.role}`, {
    level: 'error',
    extra: { role: verdict.role, reasons: verdict.reasons, nodeEnv: opts.nodeEnv },
  });

  if (opts.requireIsolated) {
    console.error(
      '[db] REQUIRE_ISOLATED_DB_ROLE=true — se aborta el arranque en vez de servir sin aislamiento.',
    );
    process.exit(1);
  }
  return verdict;
}
