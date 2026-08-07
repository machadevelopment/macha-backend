-- Promoción PARCIAL: una fila marcada ya no traba el archivo completo.
--
-- Decisión de Keneth (2026-08-07), y cambia una regla que estaba escrita como no
-- negociable, así que queda acá el porqué:
--
--   "Elimina lo de que siempre que se sube un archivo el super admin lo tiene que
--    aprobar, esto está mal. Siempre me gustaría que se pueda subir solo. El spec era si
--    un archivo se quedaba trabado o tenía algún tema complejo que no podía procesar.
--    Pero la idea es que sea libre, solo que alguno se trabe, que el equipo de Macha lo
--    pueda revisar."
--
-- LO QUE HABÍA. `PRD.md` §211 y `data model.md` §4.12 fijaban: "ninguna fila se promueve
-- mientras existan flag_reason sin resolver; la promoción del document_id es atómica
-- (todo o nada)". Llevado al extremo eso significa que UNA fila dudosa entre mil deja
-- fuera de producción a las otras 999 hasta que un humano de Macha entre al backoffice.
--
-- Medido en producción el 2026-08-06 no era teoría: `transactions`, `invoices` y `bills`
-- tenían CERO filas con 3.195 filas en staging, y de las 414 filas marcadas de un archivo
-- real 313 lo estaban por una tasa de cambio que faltaba de NUESTRO lado, no por un
-- problema del archivo del cliente. La revisión interna, pensada como excepción, se había
-- vuelto el camino obligatorio de todo upload.
--
-- LO QUE QUEDA. Se promueve lo que se puede (`clean`/`approved`) y se retiene SOLO lo
-- marcado. El archivo entra a producción el mismo día; las filas dudosas quedan en staging
-- esperando a que Macha las mire, y cuando alguien las resuelve se promueven ellas también,
-- de forma incremental.
--
-- La atomicidad SQL no se toca y no hay que confundirla con la regla anterior: cada
-- promoción sigue siendo una sola transacción que confirma todo o nada. Lo que cambia es el
-- CONJUNTO que entra en esa transacción — antes "todas las filas del documento o ninguna",
-- ahora "todas las filas promovibles o ninguna".
--
-- POR QUÉ HACE FALTA ESTA COLUMNA. Con promoción parcial el mismo documento se promueve más
-- de una vez (primero lo limpio, después lo que staff resuelva), así que la protección
-- contra doble inserción no puede seguir siendo el cerrojo por DOCUMENTO
-- (`UPDATE documents ... WHERE status <> 'promoted'`) — ese cerrojo justamente impide la
-- segunda pasada legítima. Pasa a ser POR FILA: `promoted_at` se sella en la misma
-- transacción que inserta la fila de negocio, y la promoción solo mira filas con
-- `promoted_at IS NULL`. El `UPDATE ... WHERE promoted_at IS NULL RETURNING` toma el lock de
-- cada fila, así que dos ejecuciones simultáneas no pueden reclamar la misma — es la misma
-- garantía que daba el cerrojo de documento (verificada en producción el 2026-08-06, cuando
-- pg-boss venció un job y encoló un segundo intento sobre el primero), pero al grano
-- correcto.
--
-- Retroactivo a propósito: las filas que ya existen quedan con `promoted_at` NULL, que es la
-- verdad — ninguna se promovió nunca.
ALTER TABLE staging_rows ADD COLUMN IF NOT EXISTS promoted_at timestamptz;

-- Índice parcial para la consulta de la promoción: "las filas de este documento que todavía
-- no se promovieron". Parcial y no completo porque, una vez promovido un libro grande, la
-- inmensa mayoría de sus filas dejan de calificar y no tienen por qué ocupar el índice.
CREATE INDEX IF NOT EXISTS staging_rows_pending_promotion_idx
  ON staging_rows (company_id, document_id)
  WHERE promoted_at IS NULL;

COMMENT ON COLUMN staging_rows.promoted_at IS
  'Instante en que esta fila se insertó en transactions/invoices/bills. NULL = todavía no. '
  'Es la protección por fila contra doble inserción y lo que permite promover un documento '
  'en varias pasadas (lo limpio primero, lo revisado después).';
