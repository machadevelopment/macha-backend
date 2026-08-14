-- Estado `cancelled`: la salida que un documento en proceso no tenía.
--
-- ═══ EL AGUJERO ═══
--
-- Un documento en `queued` o `processing` no tenía NINGUNA salida desde el producto:
--
--   · `POST /ingestion/:id/revert` exige `status = 'promoted'` — devuelve 409.
--   · el reintento tampoco aplica: el job sigue vivo.
--   · y no había cancelar.
--
-- O sea que si una carga se colgaba, el cliente se quedaba mirando "PROCESSING" sin ninguna
-- acción posible. Reportado el 2026-08-14: "llevo aca como 10min, y no lo procesa, tampoco
-- tengo forma de parar el upload". Hubo que destrabarlo a mano contra la base.
--
-- ═══ POR QUÉ UN ESTADO PROPIO Y NO `failed` ═══
--
-- `failed` dice "algo salió mal" y en la UI invita a reintentar. Una carga que el cliente
-- decidió parar no salió mal: la paró él. Mezclarlas haría que el panel de staff no pueda
-- distinguir un problema del producto de una decisión del usuario — y esa distinción es
-- justamente la que se mira cuando se revisa si la ingesta está sana.
--
-- Terminal, como `unsupported`: reintentar la MISMA carga cancelada no tiene sentido. Lo que
-- corresponde es subir el archivo de nuevo, y ahí la deduplicación cobra solo lo que falta.
--
-- Idempotente como todas: `migrate.ts` aplica CADA archivo en CADA invocación.

DO $$ BEGIN
  ALTER TABLE documents DROP CONSTRAINT IF EXISTS documents_status_chk;
  ALTER TABLE documents ADD CONSTRAINT documents_status_chk
    CHECK (status IN ('queued','processing','review','promoted','reverted','failed','unsupported','cancelled'));
END $$;

COMMENT ON COLUMN documents.status IS
  'queued/processing = en curso · review = filas marcadas esperando revisión interna · '
  'promoted = terminado · reverted = deshecho por el cliente · failed = error reintentable · '
  'unsupported = el archivo no se pudo leer (terminal) · cancelled = el CLIENTE paró la carga '
  '(terminal; distinto de failed, que es un problema nuestro).';
