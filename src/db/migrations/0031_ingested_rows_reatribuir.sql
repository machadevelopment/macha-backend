-- La huella de una fila se REASIGNA al documento que de verdad la tiene viva.
--
-- ═══ EL BUG DE SEGUNDO ORDEN ═══
--
-- La migración 0029/0030 arreglaron que un documento REVERTIDO dejara de bloquear cargas
-- nuevas (`findSeenFingerprints` filtra por estado). Eso destrabó el síntoma que reportó Jose
-- —"se borra un archivo, se carga otro, aparece como done y no se actualiza la data"— pero
-- dejó abierto el fallo contrario, que solo apareció al correr el ciclo completo con el worker
-- de verdad (`tests/integration/revert-y-recarga-e2e.test.ts`, paso 4):
--
--   1. `doc1` procesa el archivo y registra sus huellas apuntando a `doc1`.
--   2. El cliente revierte `doc1`.
--   3. `doc2` sube el mismo archivo. Las huellas ya no bloquean (correcto), así que procesa.
--      Pero su INSERT choca con la fila que ya existe —la PK es (company_id, fingerprint)— y
--      con `onConflictDoNothing` no pasa nada: **la huella sigue apuntando a `doc1`**.
--   4. `doc3` sube el mismo archivo otra vez. La huella apunta a `doc1`, que sigue revertido,
--      así que TAMPOCO bloquea. Se reprocesa. Y así para siempre.
--
-- O sea: revertir una vez desactivaba la deduplicación de ese archivo de forma PERMANENTE. El
-- cliente que resube su contabilidad cada semana volvería a pagarla entera, cada semana, sin
-- que nada lo indicara. Es el fallo opuesto al original y igual de silencioso.
--
-- ═══ EL ARREGLO ═══
--
-- Cuando una carga procesa una fila cuya huella ya existe pero apunta a un documento muerto,
-- la huella pasa a apuntar a la carga nueva. Así el invariante vuelve a ser cierto: **la
-- huella señala al documento cuyos datos están vivos**.
--
-- El UPDATE solo puede ocurrir en ese caso, y no por convención sino por construcción: si el
-- documento apuntado estuviera vivo, `findSeenFingerprints` habría filtrado la fila y nunca se
-- habría llegado al INSERT.
--
-- ═══ POR QUÉ HACE FALTA GRANT UPDATE ═══
--
-- `0024` dio SELECT e INSERT y nada más. `ingested_rows` NO es un ledger append-only —no está
-- en la lista de CLAUDE.md, que es contable— sino un índice de deduplicación: su valor está en
-- responder "¿esta fila ya está viva?", no en conservar la historia de quién la vio primero.
-- Esa pregunta necesita que la respuesta se pueda corregir.
--
-- Sigue SIN DELETE, y eso importa: borrar huellas al revertir habría sido la otra forma de
-- arreglar esto, y es peor. Perdería el registro de que esas filas ya se le mostraron al
-- modelo, que es justo lo que 0024 razonó que no debe perderse.

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'macha_app') THEN
    GRANT UPDATE ON ingested_rows TO macha_app;
    -- Explícito y no por omisión: el día que alguien lea estos GRANT, que quede claro que la
    -- ausencia de DELETE es una decisión y no un olvido.
    REVOKE DELETE ON ingested_rows FROM macha_app;
  END IF;
END $$;

COMMENT ON COLUMN ingested_rows.first_seen_document_id IS
  'Documento cuyas filas VIVAS respalda esta huella. Se reasigna cuando una carga nueva procesa la fila porque el documento anterior quedó revertido/fallido/cancelado — ver migración 0031. No es "quién la vio primero": es "quién la sostiene ahora".';
