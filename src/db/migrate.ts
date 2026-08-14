/**
 * Aplica las migraciones SQL de src/db/migrations en orden de nombre de archivo.
 * Los archivos generados por drizzle-kit son .sql planos y entran en el mismo orden.
 *
 * ═══ POR QUÉ HAY UN REGISTRO Y YA NO SE REAPLICA TODO SIEMPRE ═══
 *
 * Hasta el 2026-08-14 esto reaplicaba TODOS los archivos en CADA deploy, y la
 * idempotencia era responsabilidad de cada uno. El problema no era la corrección: era que
 * "no cambiar nada" igual cuesta LOCKS. Un deploy que solo tocaba documentación murió así:
 *
 *   PostgresError: deadlock detected
 *   where: SQL statement "ALTER TABLE company_users FORCE ROW LEVEL SECURITY;"
 *   error: script "db:migrate" exited with code 1
 *
 * Que reventara con un cambio de documentación es el punto entero: el contenido del deploy
 * no tenía nada que ver. Las migraciones corren mientras el contenedor VIEJO sigue
 * atendiendo tráfico; el `ALTER TABLE` pide AccessExclusiveLock, la request viva tiene
 * AccessShareLock, y Postgres mata a uno de los dos. Esta vez eligió a la migración.
 * Pudo haber elegido la query del cliente.
 *
 * Y no era solo 0010: `0012` hace DROP + CREATE de la política de aislamiento de CADA
 * tabla y de CADA partición por empresa. Con el modelo viejo, eso se ejecutaba entero en
 * cada deploy, y su costo CRECE con la cantidad de clientes. Cuantas más empresas, más
 * tablas bloqueadas por deploy.
 *
 * Guardar cada statement archivo por archivo arregla los de hoy y no los de mañana: la
 * próxima migración que alguien escriba vuelve a poner la bomba. El registro lo arregla
 * por defecto — un archivo que ya se aplicó y no cambió no se ejecuta, así que no hay
 * statement que pueda pedir un lock.
 *
 * ═══ LA EXCEPCIÓN, Y POR QUÉ EXISTE ═══
 *
 * `0010_force_rls_and_app_role.sql` DEBE reaplicarse en cada deploy, y está documentado en
 * su cabecera: su bloque GRANT/REVOKE es un no-op hasta que un operador crea el rol
 * `macha_app` a mano contra Railway (CREATE ROLE exige CREATEROLE, que la migración no
 * asume). El camino documentado para activarlo es redesplegar. Un registro que lo saltara
 * rompería ese procedimiento en silencio — y lo que quedaría roto son las garantías de
 * append-only y RLS, que es exactamente lo que nadie nota hasta que importa.
 *
 * Por eso el marcador `@reaplicar-siempre`. Es una excepción explícita y por archivo, no
 * el comportamiento por defecto. Un archivo marcado tiene que ser barato de reaplicar por
 * su cuenta: 0010 lo es porque su RLS pasa por `macha_asegurar_rls()` (que no toca la
 * tabla si ya está) y su GRANT/REVOKE sale temprano si ya se aplicó.
 *
 * ═══ EL HASH ═══
 *
 * Se registra el contenido, no solo el nombre. Editar una migración la vuelve a aplicar —
 * que es lo que hace falta cuando se corrige una, como se corrigieron las de RLS. Comparar
 * solo por nombre dejaría la corrección sin aplicar y el archivo mintiendo sobre el estado
 * real de la base.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';

const dir = join(dirname(fileURLToPath(import.meta.url)), 'migrations');
const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is not set');

/*
 * `lock_timeout` NO es una optimización, es lo que evita congelar una tabla de producción.
 *
 * Mientras una migración ESPERA un AccessExclusiveLock, toda query nueva sobre esa tabla se
 * encola detrás de ella. Sin tope, el peor caso no es "el deploy tarda más": es "la tabla
 * queda muerta para todos". Cinco segundos porque en una base sana el lock se consigue al
 * instante; si no se consiguió en cinco, hay algo vivo encima y esperar más solo alarga
 * la cola.
 *
 * El valor va en MILISEGUNDOS: `lock_timeout` sin unidad las asume, y los tipos de
 * postgres.js solo aceptan número, así que no hay dónde escribir "5s" y equivocarse de
 * escala por mil.
 */
const sql = postgres(url, { max: 1, connection: { lock_timeout: 5_000 } });

/** Un archivo con este marcador se reaplica en cada invocación. Ver la cabecera. */
const MARCADOR_SIEMPRE = '@reaplicar-siempre';

/** Códigos que significan "otro proceso tenía la tabla", no "la migración está mal". */
const CONTENCION = new Set(['55P03', '40P01']); // lock_timeout · deadlock detected

const hash = (s: string): string => new Bun.CryptoHasher('sha256').update(s).digest('hex');

await sql.unsafe(`
  CREATE TABLE IF NOT EXISTS schema_migrations (
    filename   text PRIMARY KEY,
    sha256     text NOT NULL,
    applied_at timestamptz NOT NULL DEFAULT now()
  )
`);

const yaAplicadas = new Map<string, string>();
for (const r of await sql.unsafe<{ filename: string; sha256: string }[]>(
  'SELECT filename, sha256 FROM schema_migrations',
)) {
  yaAplicadas.set(r.filename, r.sha256);
}

const files = readdirSync(dir)
  .filter((f) => f.endsWith('.sql'))
  .sort();

let aplicadas = 0;
let saltadas = 0;

for (const f of files) {
  const body = readFileSync(join(dir, f), 'utf8');
  const suma = hash(body);
  const siempre = body.includes(MARCADOR_SIEMPRE);

  if (!siempre && yaAplicadas.get(f) === suma) {
    saltadas++;
    continue;
  }

  process.stdout.write(`applying ${f}${siempre ? ' (@reaplicar-siempre)' : ''} ... `);

  /*
   * Un reintento, no más. La contención con el contenedor viejo es momentánea —la request
   * que tenía la tabla termina— así que un segundo intento la resuelve. Insistir más
   * escondería una migración que de verdad choca con algo, y eso hay que verlo en rojo.
   */
  for (let intento = 1; ; intento++) {
    try {
      await sql.unsafe(body);
      break;
    } catch (e) {
      const codigo = (e as { code?: string }).code ?? '';
      if (intento > 1 || !CONTENCION.has(codigo)) throw e;
      console.log(`contención (${codigo}), reintentando una vez`);
      process.stdout.write(`applying ${f} ... `);
    }
  }

  await sql.unsafe(
    `INSERT INTO schema_migrations (filename, sha256) VALUES ($1, $2)
     ON CONFLICT (filename) DO UPDATE SET sha256 = excluded.sha256, applied_at = now()`,
    [f, suma],
  );
  aplicadas++;
  console.log('ok');
}

await sql.end();
console.log(`done (${aplicadas} aplicadas, ${saltadas} ya estaban, ${files.length} en total).`);
