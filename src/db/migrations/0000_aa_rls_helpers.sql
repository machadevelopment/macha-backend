-- Aplica RLS a una tabla SIN pedir el lock cuando ya está aplicado.
--
-- ═══ EL FALLO QUE LO MOTIVA (producción, 2026-08-14) ═══
--
-- Un deploy que solo cambiaba documentación falló así:
--
--   PostgresError: deadlock detected
--   where: SQL statement "ALTER TABLE company_users FORCE ROW LEVEL SECURITY;"
--   detail: Process 49480 waits for AccessExclusiveLock on relation 16559;
--           blocked by process 49453.
--           Process 49453 waits for AccessShareLock on relation 17046;
--           blocked by process 49480.
--   error: script "db:migrate" exited with code 1
--
-- El contenido del deploy es IRRELEVANTE, y eso es lo que hay que entender: `migrate.ts`
-- reaplica TODOS los archivos en CADA deploy, y ocho de ellos emiten
-- `ALTER TABLE ... ENABLE/FORCE ROW LEVEL SECURITY` sin preguntar si ya está puesto. Eso
-- toma un AccessExclusiveLock sobre ~23 tablas de producción, cada vez, para no cambiar
-- absolutamente nada. Mientras tanto el contenedor VIEJO sigue atendiendo tráfico y tiene
-- AccessShareLock sobre esas mismas tablas. El choque no es determinista: depende de si
-- justo en ese instante hay una request viva.
--
-- ═══ POR QUÉ NO ES SOLO UN DEPLOY EN ROJO ═══
--
-- Postgres resuelve el deadlock matando a UNO de los dos. Esta vez eligió a la migración.
-- Pudo haber elegido la query del cliente — y entonces el error no habría salido en el log
-- de deploy sino en la pantalla de alguien usando el producto.
--
-- Y aun sin deadlock, mientras la migración ESPERA el AccessExclusiveLock, toda query nueva
-- sobre esa tabla se encola detrás. O sea: el peor caso de esperar más no es tardar más, es
-- congelar la tabla para todos.
--
-- ═══ LA SOLUCIÓN ═══
--
-- Preguntar primero. `pg_class.relrowsecurity` y `relforcerowsecurity` dicen si ya está.
-- Si lo está —que es el caso en cada deploy después del primero— no se emite el ALTER y no
-- se pide ningún lock. La primera vez sí lo pide, que es cuando de verdad hay que cambiar
-- algo.
--
-- Las dos banderas van juntas a propósito: `ENABLE` no aplica al DUEÑO de la tabla, y el rol
-- que corre las migraciones es el dueño (verificado contra una instancia real, ver
-- `0010_force_rls_and_app_role.sql`). Una tabla con ENABLE y sin FORCE tiene el backstop
-- apagado justo para el rol que más importa. Cada llamada deja las dos puestas, que es el
-- estado final que ya tenían todas las tablas al terminar 0010/0019.
--
-- ═══ POR QUÉ EL NOMBRE EMPIEZA EN 0000_aa ═══
--
-- `migrate.ts` aplica los archivos ORDENADOS POR NOMBRE, y esta función tiene que existir
-- antes de que `0002_partitions_rls.sql` la llame. `0000_aa_` ordena antes que
-- `0000_peaceful_mandroid.sql` y que todo lo demás.
--
-- Toda migración futura que active RLS debería llamar a esto en vez de emitir el ALTER
-- directo. No es preferencia de estilo: el ALTER directo vuelve a poner una bomba de tiempo
-- en cada deploy, para siempre, a cambio de nada.

CREATE OR REPLACE FUNCTION macha_asegurar_rls(tabla text)
RETURNS void
LANGUAGE plpgsql
AS $fn$
DECLARE
  ya_habilitado boolean;
  ya_forzado    boolean;
BEGIN
  SELECT c.relrowsecurity, c.relforcerowsecurity
    INTO ya_habilitado, ya_forzado
    FROM pg_class c
   WHERE c.oid = format('%I', tabla)::regclass;

  -- Cada ALTER va bajo su propio IF: una tabla puede tener ENABLE sin FORCE (así quedaban
  -- las de 0002/0009 hasta que 0010 las forzaba), y ahí solo hace falta el segundo.
  IF NOT ya_habilitado THEN
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY;', tabla);
  END IF;

  IF NOT ya_forzado THEN
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY;', tabla);
  END IF;
END
$fn$;
