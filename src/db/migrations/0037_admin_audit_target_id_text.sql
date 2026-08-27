-- `admin_audit_log.target_id` pasa de `uuid` a `text` (bug reportado por Jose, 2026-08-27).
--
-- ═══ EL SÍNTOMA ═══
--
-- Guardar cualquier cambio en `/admin/plans` mostraba "Unexpected server error" en rojo y el
-- cambio no se guardaba. El ticket lo atribuía a que faltara el
-- `GRANT ... ON plans TO macha_app` de la migración 0021 —una hipótesis razonable, porque esa
-- migración advierte por escrito de ese riesgo—. **Medido contra producción: es falsa.**
-- `macha_app` tiene SELECT, INSERT, UPDATE y DELETE sobre `plans`.
--
-- ═══ LA CAUSA REAL, REPRODUCIDA CONECTÁNDOSE COMO `macha_app` ═══
--
--     update plans set ... where code = 'starter';           -- UPDATE 1  ✔
--     insert into admin_audit_log (..., target_id, ...) values (..., 'starter', ...);
--     ERROR:  invalid input syntax for type uuid: "starter"
--
-- `target_id` era `uuid`, pero la tabla es un registro GENÉRICO: su `target_table` es texto
-- libre, así que la clave de la fila apuntada no tiene por qué ser un uuid. Tres tablas del
-- producto tienen clave de texto y las tres rompían al auditarse:
--
--     · `plans.code`            → `POST /admin/plans` y `PATCH /admin/plans/:code`
--     · `platform_settings.key` → `PATCH /admin/config/:key`
--
-- El insert del audit corre DENTRO de la misma transacción que la escritura de negocio (el
-- guard de `/admin/*` reserva la conexión y abre `begin`), así que el error no solo devolvía
-- 500: **deshacía el cambio**. Y como un error de Postgres sin clasificar cae al `else` del
-- manejador global —que a propósito no filtra detalles de la base—, el operador veía un texto
-- genérico que no decía nada.
--
-- ═══ NUNCA FUNCIONÓ, Y LOS DATOS DE PRODUCCIÓN LO CONFIRMAN ═══
--
--     select count(*) from platform_settings;                          → 0
--     select count(*) filter (where updated_at > created_at) from plans; → 0
--
-- Cero planes editados alguna vez y cero parámetros guardados. `CLAUDE.md` ya registraba que
-- "Parámetros de negocio" mostraba la configuración vacía y lo atribuía a que la fila se crea
-- al editar; la otra mitad de la explicación es esta: **editar era imposible**.
--
-- ═══ POR QUÉ SE CAMBIA LA COLUMNA Y NO LOS TRES LLAMADORES ═══
--
-- La alternativa era mandar el código a `metadata` y dejar `target_id` en NULL. Se descarta:
-- `target_id` existe para poder preguntar "qué se le hizo a ESTA fila", y responder eso con
-- un campo dentro de un JSON es tener la columna y no usarla. El tipo es lo que estaba mal —
-- `target_table` ya es texto genérico y `target_id` tenía que serlo también.
--
-- ═══ SOBRE EL LOCK, QUE EN ESTE PROYECTO NO ES UN DETALLE ═══
--
-- `ALTER COLUMN ... TYPE` reescribe la tabla y pide AccessExclusiveLock, que es exactamente lo
-- que tumbó un deploy el 2026-08-14. Acá es aceptable y conviene dejar medido por qué:
-- `admin_audit_log` tiene **21 filas y 80 kB** en producción, así que la reescritura es
-- instantánea, y `migrate.ts` corre con `lock_timeout` de 5 s más un reintento. Si algún día
-- esta tabla crece a millones de filas, este `ALTER` deja de ser barato.
--
-- El `IF` la vuelve un no-op cuando ya está aplicada: sin él, editar cualquier otra cosa de
-- este archivo la reaplicaría (el registro guarda el sha256 del contenido) y volvería a pedir
-- el lock a cambio de nada.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'admin_audit_log'
       AND column_name = 'target_id'
       AND data_type = 'uuid'
  ) THEN
    ALTER TABLE admin_audit_log ALTER COLUMN target_id TYPE text USING target_id::text;
  END IF;
END $$;
