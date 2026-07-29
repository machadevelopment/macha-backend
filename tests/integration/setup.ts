import postgres from 'postgres';

/**
 * Prepara la base de test para los tests de integración (CU-868kh8zbj).
 *
 * Reproduce a propósito el procedimiento REAL de despliegue documentado en la
 * cabecera de `0010_force_rls_and_app_role.sql`, en el mismo orden:
 *
 *   1. correr todas las migraciones con el rol DUEÑO;
 *   2. crear `macha_app` a mano (en producción lo hace un operador una vez contra
 *      Railway, porque CREATE ROLE exige CREATEROLE y la migración no lo asume);
 *   3. re-aplicar 0010, cuyo bloque GRANT/REVOKE solo surte efecto una vez que el rol
 *      existe — hasta entonces es un no-op que solo emite un NOTICE.
 *
 * Ese paso 3 es la parte que más fácil se rompe en producción si alguien "limpia" la
 * migración pensando que ya corrió: aquí queda ejercitada en cada corrida de CI.
 */

const OWNER_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://macha_owner:macha_test@localhost:55432/macha_test';

const APP_PASSWORD = 'macha_app_test';

export const testOwnerUrl = OWNER_URL;
export const testAppUrl = OWNER_URL.replace(/\/\/[^@]+@/, `//macha_app:${APP_PASSWORD}@`);

/**
 * `macha_app` se crea con exactamente los mismos atributos que documenta la migración.
 * NOSUPERUSER y NOBYPASSRLS no son decorativos: un superusuario ignora RLS y un rol con
 * BYPASSRLS también, así que sin ellos los tests de aislamiento pasarían siempre y no
 * detectarían nada.
 */
export async function setupTestDatabase(): Promise<void> {
  const owner = postgres(OWNER_URL, { max: 1, onnotice: () => {}, connect_timeout: 10 });
  try {
    await owner.unsafe(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'macha_app') THEN
          CREATE ROLE macha_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS
            PASSWORD '${APP_PASSWORD}';
        END IF;
      END $$;
    `);
  } finally {
    await owner.end();
  }
}

// `connect_timeout` en todas: sin él, una URL mal apuntada deja al test colgado en
// lugar de fallar, y en CI eso significa un job corriendo hasta el timeout del runner.
const CONNECT_OPTS = { max: 1, onnotice: () => {}, connect_timeout: 10 } as const;

/** Conexión con el rol restringido — lo que de verdad usa la app en runtime. */
export function appConnection() {
  return postgres(testAppUrl, CONNECT_OPTS);
}

/** Conexión con el rol dueño — solo para montar datos de prueba, nunca para aserciones. */
export function ownerConnection() {
  return postgres(OWNER_URL, CONNECT_OPTS);
}

/**
 * Los 6 ledgers append-only de CLAUDE.md. Se listan aquí y no en cada test para que
 * agregar un ledger nuevo a la regla obligue a tocar un solo sitio.
 */
export const APPEND_ONLY_LEDGERS = [
  'ai_usage_events',
  'credit_transactions',
  'admin_audit_log',
  'report_versions',
  'industry_template_versions',
  'payments',
] as const;
