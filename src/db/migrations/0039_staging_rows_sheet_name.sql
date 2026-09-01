-- ═══════════════════════════════════════════════════════════════════════════════════════════
-- 0039 — DE QUÉ HOJA SALIÓ CADA FILA DE STAGING
-- ═══════════════════════════════════════════════════════════════════════════════════════════
--
-- POR QUÉ. El cuadre (`lib/cuadre.ts`) compara lo LEÍDO del archivo contra lo ATERRIZADO en el
-- ledger, y lo hace sumando el DOCUMENTO ENTERO. Eso tiene un agujero que se ve en cuanto se
-- escribe: un libro donde una hoja aterriza el DOBLE y otra aterriza CERO **cuadra perfecto**,
-- porque los dos errores se cancelan en el total. Y esa es exactamente la forma de los fallos
-- de composición que llevamos meses persiguiendo — dos filtros correctos por separado que
-- juntos pierden una hoja mientras otra se cuenta dos veces.
--
-- Sin saber de qué hoja vino cada fila, el cuadre por hoja es imposible. `ingested_rows` y
-- `document_ingest_batches` ya guardan `sheet_name`; `staging_rows`, que es donde vive el
-- dinero antes de promoverse, no lo guardaba.
--
-- QUÉ MÁS HABILITA, y no es menor: la cola de revisión interna puede decir "esta fila viene de
-- `CuentasPorCobrar`". Hoy un operador ve una fila suelta sin saber de dónde salió.
--
-- NULLABLE Y SIN DEFAULT, A PROPÓSITO:
--   · `ADD COLUMN` nullable sin default no reescribe la tabla ni pide un lock largo — y estas
--     migraciones corren sobre producción mientras el contenedor viejo sigue atendiendo
--     tráfico (ver la nota de `schema_migrations` en CLAUDE.md).
--   · NULL significa "carga anterior a esta migración", que es información legítima y distinta
--     de una cadena vacía. El cuadre por hoja se saltea esas filas en vez de inventarles un
--     nombre.
--
-- NO lleva índice: la única consulta que la usa agrupa por (document_id, sheet_name) sobre las
-- filas de UN documento, y `staging_rows_company_document_idx` ya la resuelve. Un índice más
-- sobre una tabla de escritura intensa se paga en cada inserción de cada carga.

ALTER TABLE staging_rows ADD COLUMN IF NOT EXISTS sheet_name text;

COMMENT ON COLUMN staging_rows.sheet_name IS
  'Hoja del Excel de la que salió esta fila. NULL = carga anterior a la migración 0039. Lo usa el cuadre POR HOJA (lib/cuadre.ts): sin él, una hoja que aterriza el doble y otra que aterriza cero se cancelan en el total del documento y la carga parece correcta.';
