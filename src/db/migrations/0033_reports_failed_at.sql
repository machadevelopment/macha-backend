-- CU-868ktkuq0 — DISTINGUIR "SE ESTÁ GENERANDO" DE "FALLÓ".
--
-- `GET /reports` derivaba un solo booleano, `ready = current_version_id IS NOT NULL`, y con
-- eso la lista pintaba dos estados: verde "Listo" o rojo "No generado".
--
-- El problema es que esos dos no son los únicos estados que existen. La fila de `reports` se
-- crea ANTES de encolar el job —hay que devolverle un id al usuario— así que entre que el
-- reporte se encola y que el worker escribe su versión, `current_version_id` es NULL. O sea
-- que un reporte que va perfectamente se le muestra al cliente en ROJO y diciendo que no se
-- generó, durante todo el rato que tarda la IA en escribir la narrativa.
--
-- CU-868krw2wn introdujo ese booleano para arreglar el problema contrario (un reporte fallido
-- se veía idéntico a uno bueno) y quedó corto por un estado: colapsó "todavía no" con "ya no
-- va a haber". Esta columna lo separa.
--
-- POR QUÉ UNA MARCA DE FALLO Y NO UNA COLUMNA `status`:
-- el estado feliz ya lo dice `current_version_id`, que es la fuente de verdad de que el
-- reporte TIENE contenido. Un `status` paralelo podría contradecirla —quedar en 'pending' con
-- la versión ya escrita si el UPDATE se pierde— y entonces habría dos verdades sobre lo
-- mismo. Con una marca de fallo solamente, el orden de lectura es inequívoco: si hay versión
-- está listo, si no y hay marca falló, y si no hay ninguna de las dos se está generando.
--
-- `reports` NO está en la lista de ledgers de solo-inserción del CLAUDE.md (el append-only es
-- `report_versions`), así que un UPDATE sobre esta columna es legítimo.
--
-- ADD COLUMN sin default ni NOT NULL: en PostgreSQL es solo un cambio de catálogo, no
-- reescribe la tabla, y el AccessExclusiveLock se toma y se suelta de inmediato. Importa
-- porque esto corre contra producción mientras el contenedor viejo sigue atendiendo tráfico.

ALTER TABLE reports ADD COLUMN IF NOT EXISTS failed_at timestamptz;

COMMENT ON COLUMN reports.failed_at IS
  'CU-868ktkuq0: cuándo falló la generación. Se limpia al escribirse una versión, así que un reintento exitoso lo borra. NULL sin versión = generándose.';
