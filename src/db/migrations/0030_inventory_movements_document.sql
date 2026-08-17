-- De qué carga salió cada movimiento de inventario.
--
-- ═══ EL HUECO QUE TAPA ═══
--
-- Desde CU-868krkfrh el Excel del cliente puede poblar el inventario: una hoja de existencias
-- se convierte en altas y ajustes sobre `inventory_movements`. Pero esos movimientos nacían
-- SIN ninguna referencia al documento que los originó, y `revertDocument` no los tocaba.
--
-- Consecuencia: el cliente revertía una carga —porque el archivo estaba mal— y su
-- contabilidad volvía atrás, pero **su inventario se quedaba con los números del archivo malo,
-- para siempre y sin forma de deshacerlo desde la interfaz**. Ni siquiera había cómo saber qué
-- movimientos habían salido de esa carga.
--
-- Es exactamente la clase de inconsistencia silenciosa que la ronda de arreglos de hoy vino a
-- eliminar, y la introdujo el propio import de inventario. Se corrige antes de que llegue a
-- un cliente.
--
-- ═══ NULLABLE, Y ESO SIGNIFICA ALGO ═══
--
-- `NULL` = movimiento hecho A MANO desde la pantalla de Inventario, que es el camino original
-- y el mayoritario. Esos NO se revierten con un documento porque no salieron de ninguno:
-- revertir una carga no puede deshacer el conteo físico que alguien registró después.
--
-- Sin FK a `documents` a propósito: el movimiento es un hecho del ledger append-only y tiene
-- que sobrevivir aunque algún día se purgue el documento. La columna es trazabilidad, no
-- integridad referencial.
--
-- `ADD COLUMN` nullable y sin default: cambio solo de catálogo, sin reescribir la tabla ni
-- pedir un lock largo (las migraciones corren con el contenedor viejo sirviendo tráfico).

ALTER TABLE inventory_movements ADD COLUMN IF NOT EXISTS document_id uuid;

COMMENT ON COLUMN inventory_movements.document_id IS
  'Carga de Excel que originó este movimiento. NULL = registrado a mano desde la pantalla de Inventario. Lo usa revertDocument para compensar el inventario de una carga revertida. Ver migración 0030.';

-- Índice parcial: la única consulta es "los movimientos de ESTA carga", y solo para las filas
-- que vienen de una. Un índice completo indexaría los NULL de todos los movimientos manuales,
-- que son la mayoría y que nadie consulta por esta columna.
CREATE INDEX IF NOT EXISTS inventory_movements_document_idx
  ON inventory_movements (company_id, document_id)
  WHERE document_id IS NOT NULL;
