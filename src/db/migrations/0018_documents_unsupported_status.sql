-- Estado terminal `unsupported` para documents.
--
-- Decisión de Keneth (2026-08-06): el motor tiene que poder con cualquier Excel, pero
-- si el archivo es genuinamente ilegible —notas libres, una hoja de gráficas, algo sin
-- movimientos identificables— el cliente tiene que oírlo y tener una salida concreta
-- (descargar la plantilla y llenarla), no quedarse esperando.
--
-- Hasta ahora ese archivo terminaba en `review`: `promoteDocument` devolvía `no_rows`
-- y el worker caía en la misma rama que las filas marcadas. O sea el cliente veía "En
-- revisión" indefinidamente por un documento que no tenía NADA que revisar, y del lado
-- de Macha aparecía una revisión interna vacía. Es un estado distinto y necesita
-- nombre propio: `failed` es "algo se rompió de nuestro lado, reintenta" y este es "el
-- archivo no se puede leer, reintentarlo da lo mismo".
--
-- Solo cambia el CHECK. Ninguna fila existente cambia de estado: `unsupported` es un
-- valor nuevo que solo escribe el worker de aquí en adelante.
DO $$ BEGIN
  ALTER TABLE documents DROP CONSTRAINT IF EXISTS documents_status_chk;
  ALTER TABLE documents ADD CONSTRAINT documents_status_chk
    CHECK (status IN ('queued','processing','review','promoted','reverted','failed','unsupported'));
END $$;
