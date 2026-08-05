-- pg-boss vive en su PROPIO esquema, y 0010 solo concedió sobre `public`.
--
-- Detectado en producción el 2026-08-05, subiendo un Excel real:
--
--   POST /documents -> 500  "permission denied for schema pgboss"
--
-- El esquema `pgboss` lo crea la propia librería la primera vez que arranca. Mientras la
-- app corría como dueño (`postgres`), todo funcionaba. Al completar el runbook de
-- aislamiento y pasar a `macha_app`, el rol se quedó sin USAGE siquiera:
--
--   has_schema_privilege('macha_app','pgboss','USAGE') -> false
--
-- O sea: el aislamiento quedó bien, pero los permisos quedaron incompletos. Y lo que se
-- rompe no es un detalle — TODO lo asíncrono pasa por esta cola:
--   · ingesta de Excel (excel.ingest)      · generación de reportes (report.generate)
--   · evaluación de alertas (alert.evaluate) · envío de correo (email.send)
--   · respaldo nocturno (db.backup)         · el tick de reportes (report.tick)
-- más el gate de profundidad de cola de `lib/rate-limit.ts`, que lee `pgboss.job`.
--
-- Por qué CREATE y no solo USAGE: pg-boss instala y migra sus propias tablas al
-- arrancar. Si el rol no puede crear dentro de su esquema, un entorno nuevo —o una
-- versión nueva de la librería que traiga migración— falla al levantar. El esquema se
-- crea aquí para que exista incluso antes del primer arranque.
--
-- Por qué esto NO relaja el aislamiento: `pgboss` no guarda datos de negocio. Son la
-- cola de trabajos y su bookkeeping. Las garantías que importan —RLS por company_id y
-- append-only de los seis ledgers— viven en `public` y no cambian aquí. El payload de
-- un job sí lleva `companyId`, pero es el worker quien lo scopea vía
-- `reserveCompanyConnection` (db-scope.ts), igual que antes.
--
-- Idempotente y re-ejecutable en cada deploy, como 0010: si `macha_app` todavía no
-- existe, no hace nada y lo dice.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'macha_app') THEN
    RAISE NOTICE 'macha_app role does not exist yet — skipping pgboss GRANT block. See 0010 for the manual CREATE ROLE step.';
    RETURN;
  END IF;

  -- El esquema puede no existir todavía (base nueva donde la app no ha arrancado).
  CREATE SCHEMA IF NOT EXISTS pgboss;

  GRANT USAGE, CREATE ON SCHEMA pgboss TO macha_app;
  EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA pgboss TO macha_app';
  EXECUTE 'GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA pgboss TO macha_app';

  -- Para lo que se cree DESPUÉS: sin esto, la próxima versión de la librería que añada
  -- una tabla vuelve a dejar al rol fuera, y el síntoma sería el mismo 500 opaco.
  --
  -- Sin `FOR ROLE`, ALTER DEFAULT PRIVILEGES aplica a lo que cree `current_user` — el
  -- dueño, que es quien corre esta migración. Ese es justo el caso que hay que cubrir:
  -- las tablas actuales de `pgboss` en producción las creó el dueño, porque la app
  -- arrancó como dueño antes del runbook de aislamiento. Lo que cree `macha_app` de aquí
  -- en adelante no necesita GRANT: será suyo, y el dueño de una tabla ya tiene todo
  -- sobre ella.
  ALTER DEFAULT PRIVILEGES IN SCHEMA pgboss
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO macha_app;
  ALTER DEFAULT PRIVILEGES IN SCHEMA pgboss
    GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO macha_app;
END
$$;
