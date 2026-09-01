-- ═══════════════════════════════════════════════════════════════════════════════════════════
-- 0041 — UN CUARTO TIPO DE CORREO: `review_needed`
-- ═══════════════════════════════════════════════════════════════════════════════════════════
--
-- POR QUÉ ES OBLIGATORIA Y EL TICKET NO LA PEDÍA. `EmailSendPayload.kind` es un tipo de
-- TypeScript; el que manda de verdad es este CHECK. El worker de correo escribe una fila en
-- `notifications` por cada envío con empresa, así que sin ampliar la restricción el job
-- **falla al insertar DESPUÉS de haber mandado el correo**: el cliente lo recibe y nosotros
-- lo registramos como fallido.
--
-- Es exactamente la lección que dejó escrita la migración 0017 al agregar `invitation`:
-- *"un tipo de TypeScript más ancho que la restricción de la base solo mueve el fallo a
-- runtime"*. `demo_request` no la necesitó porque va con `company_id` nulo y el worker se
-- salta esta tabla — es el caso especial, no el patrón.
--
-- SE HACE EN UNA TRANSACCIÓN IMPLÍCITA Y CON `DROP ... IF EXISTS` PRIMERO, igual que 0017:
-- Postgres no tiene `ALTER CONSTRAINT` para cambiar la expresión de un CHECK.
--
-- ⚠️ El `NOT VALID` NO se usa acá a propósito. Sirve para no escanear la tabla al agregar una
-- restricción que las filas viejas podrían violar; acá el conjunto nuevo es un SUPERCONJUNTO
-- del anterior, así que ninguna fila existente puede violarlo y el escaneo es barato sobre una
-- tabla que crece con los correos enviados, no con las transacciones del cliente.

ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_kind_chk;

ALTER TABLE notifications
  ADD CONSTRAINT notifications_kind_chk
  CHECK (kind IN ('report', 'alert', 'invitation', 'review_needed'));

COMMENT ON COLUMN notifications.kind IS
  'Tipo de correo. `review_needed` (migración 0041) avisa que una carga dejó conceptos que solo el cliente puede clasificar; su `ref_id` es el documents.id, y esa fila ES el registro de idempotencia que impide mandarlo dos veces por la misma carga.';
