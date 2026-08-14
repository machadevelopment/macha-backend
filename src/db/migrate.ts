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
 * ═══ EL HASH LLEVA ALGO MÁS QUE EL CONTENIDO, Y ES LA PARTE QUE ME EQUIVOQUÉ ═══
 *
 * Se registra el contenido, no solo el nombre: editar una migración la vuelve a aplicar,
 * que es lo que hace falta cuando se corrige una. Comparar solo por nombre dejaría la
 * corrección sin aplicar y el registro mintiendo sobre el estado real de la base.
 *
 * Pero el contenido NO alcanza, porque hay migraciones que hacen COSAS DISTINTAS según el
 * entorno. Once archivos otorgan privilegios a `macha_app`, un rol que un operador crea a
 * MANO contra Railway (CREATE ROLE exige CREATEROLE, que las migraciones no asumen). Antes
 * de que exista, esos bloques son no-ops que solo emiten un NOTICE; el camino documentado
 * para activarlos es redesplegar.
 *
 * Mi primera versión marcaba solo `0010` como "reaplicar siempre", asumiendo que era el
 * único con esa dependencia. Era falso —son once— y el registro dejó a `0016` (grants de
 * pgboss) y `0019` (append-only de inventory_movements) grabados como aplicados cuando
 * habían sido no-ops. Lo atrapó CI, no yo: cinco tests de integración en rojo contra una
 * base limpia, mientras que en mi máquina pasaban porque los privilegios ya estaban puestos
 * de corridas anteriores.
 *
 * Por eso la clave del registro incluye si el rol EXISTE. No hay que acertar qué archivos
 * dependen de él: cuando el rol aparece, la clave de todos cambia, todos se reaplican una
 * vez y los grants surten efecto. Después vuelve a ser estable y no se aplica ninguno.
 * Enumerar a mano era el error; esto no requiere enumerar.
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

/** Códigos que significan "otro proceso tenía la tabla", no "la migración está mal". */
const CONTENCION = new Set(['55P03', '40P01']); // lock_timeout · deadlock detected

const hash = (s: string): string => new Bun.CryptoHasher('sha256').update(s).digest('hex');

/*
 * Parte del entorno que cambia lo que HACEN las migraciones, no solo lo que dicen. Ver la
 * cabecera: once archivos otorgan privilegios a `macha_app` y son no-ops mientras el rol no
 * exista. Va en la clave del registro para que crearlo dispare una reaplicación completa.
 */
const filasRol = await sql.unsafe<{ hay_rol: boolean }[]>(
  `SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'macha_app') AS hay_rol`,
);
const entorno = `macha_app=${filasRol[0]?.hay_rol === true}`;

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
  const suma = hash(`${body}\n-- ${entorno}`);

  if (yaAplicadas.get(f) === suma) {
    saltadas++;
    continue;
  }

  process.stdout.write(`applying ${f} ... `);

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
