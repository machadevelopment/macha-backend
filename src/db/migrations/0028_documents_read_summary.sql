-- Qué entendió el sistema del archivo del cliente (CU-868krmrcj).
--
-- ═══ QUÉ PROBLEMA RESUELVE ═══
--
-- Hoy el cliente sube un Excel y recibe números. No hay forma de que sepa QUÉ se leyó de su
-- archivo: ni de qué columna salió el monto, ni qué hojas se descartaron, ni cuántas filas.
-- Todo eso el worker lo sabe y lo manda a `console.info`, que rota con los logs de Railway.
--
-- Los dos fallos que de verdad hacen daño en una ingesta son SILENCIOSOS:
--
--   · Leer mal — el dato entra desde la columna equivocada, con números plausibles y cero
--     errores. En un producto de CFO es el que destruye la confianza.
--   · Perder — el pre-filtro descarta ~50 % de las filas de cada archivo. La hoja de
--     inventario se tiró durante MESES (211 filas por carga, en tres empresas) y nadie se
--     enteró hasta que un cliente preguntó por qué su inventario estaba vacío.
--
-- Ninguno de los dos se arregla restringiendo lo que el cliente puede subir, que era la
-- propuesta original del ticket: se arreglan haciéndolos visibles. Un mapeo equivocado deja
-- de ser invisible en cuanto la pantalla dice "el monto lo leímos de «Precio Unitario»" y el
-- dueño responde "esa no es".
--
-- ═══ POR QUÉ UNA COLUMNA jsonb Y NO UNA TABLA ═══
--
-- La cardinalidad es exactamente uno por documento y siempre se lee entero, junto con el
-- documento. Una tabla aparte agregaría un JOIN, su propia RLS y su propio GRANT para
-- guardar un objeto que nunca se consulta por partes ni se agrega entre documentos.
--
-- `documents` NO está particionada (a diferencia de transactions/invoices/bills), así que
-- `ADD COLUMN` acá no se multiplica por empresa.
--
-- ═══ ES NULLABLE, Y ESO SIGNIFICA ALGO ═══
--
-- `NULL` = documento anterior a esta migración, o que nunca llegó a procesarse. Distinto de
-- un resumen vacío, que sería "se procesó y no se entendió nada". La UI tiene que poder
-- separarlos: al primero no le debe nada al cliente, del segundo sí.
--
-- `ADD COLUMN ... IF NOT EXISTS` con un tipo nullable y sin default no reescribe la tabla ni
-- pide un lock largo: en Postgres moderno es un cambio solo de catálogo. Es deliberado — las
-- migraciones corren mientras el contenedor viejo sigue atendiendo tráfico (ver la nota de
-- `schema_migrations` en CLAUDE.md).

ALTER TABLE documents ADD COLUMN IF NOT EXISTS read_summary jsonb;

COMMENT ON COLUMN documents.read_summary IS
  'Qué entendió el sistema del archivo: hojas procesadas, descartadas con su motivo, y de qué columna salió cada campo. NULL = documento anterior a la migración 0028 o que no llegó a procesarse. Ver src/lib/read-summary.ts.';

-- Sin índice: se lee siempre por `documents.id` o por `company_id`, que ya los tienen. Un
-- índice GIN sobre este jsonb costaría escritura en cada carga para consultas que nadie hace.

-- No hace falta tocar RLS ni GRANTs: es una columna de una tabla que ya los tiene, y el rol
-- `macha_app` ya puede escribir `documents` (es quien actualiza el status en cada paso).
