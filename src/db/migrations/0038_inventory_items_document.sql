-- ═══════════════════════════════════════════════════════════════════════════════════════════
-- EL ARTÍCULO TIENE QUE SABER QUÉ CARGA LO CREÓ, AUNQUE HAYA NACIDO EN CERO
-- ═══════════════════════════════════════════════════════════════════════════════════════════
--
-- Reporte de Keneth (2026-08-30): tras revertir sus cargas, el inventario seguía mostrando
-- vehículos. La primera causa —el artículo se quedaba en cero pero no se daba de baja— se
-- arregló en `compensarInventario`. Esta es la SEGUNDA, y es la que dejaba 240 artículos fuera
-- del alcance de aquel arreglo:
--
-- `createItem` registra el movimiento de apertura solo `if (inicial > 0)`, y hace bien —
-- `recordMovement` rechaza una cantidad de cero, porque un movimiento de cero no movió nada.
-- Pero entonces **un artículo importado con existencia 0 no tiene NI UN movimiento**, y como
-- `document_id` solo vivía en `inventory_movements`, no quedaba rastro de qué carga lo creó.
--
-- El resultado es un artículo invisible para las dos defensas a la vez:
--   · `compensarInventario` no lo alcanza (no hay movimiento que compensar);
--   · el script de limpieza lo PROTEGE, porque «sin movimientos» es justo su señal de que lo
--     dio de alta una persona a mano.
--
-- Medido en producción: 240 vehículos así en una sola empresa, todos creados el mismo día.
--
-- ═══ POR QUÉ UNA COLUMNA Y NO UN MOVIMIENTO DE CERO ═══
--
-- La alternativa era relajar `recordMovement` para admitir cantidad 0 y registrar siempre la
-- apertura. Se descartó: ese contrato («un movimiento mueve algo») es correcto y lo usa todo el
-- ledger de inventario; romperlo para resolver un caso de trazabilidad metería filas que no
-- significan nada en el historial que el cliente lee.
--
-- Lo que faltaba no era un movimiento: era saber de dónde salió el artículo. Eso es un atributo
-- del artículo, no un hecho del inventario.
--
-- `ADD COLUMN` nullable y sin default: cambio solo de catálogo, sin reescribir la tabla ni
-- tomar el lock más de un instante. NULL = lo creó una persona a mano, que es el caso original
-- y sigue siendo válido.
ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS document_id uuid;

-- Sin FK a `documents`, igual que en `inventory_movements` (0030): un artículo tiene que
-- sobrevivir al borrado de la carga que lo originó — es un objeto del negocio del cliente, no
-- una fila derivada. El índice existe para el revert, que busca por (empresa, documento).
CREATE INDEX IF NOT EXISTS inventory_items_company_document_idx
  ON inventory_items (company_id, document_id)
  WHERE document_id IS NOT NULL;
