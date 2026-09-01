-- ═══════════════════════════════════════════════════════════════════════════════════════════
-- EL PORTÓN: NADA ENTRA AL DASHBOARD SIN QUE EL CLIENTE LO CONFIRME (2026-09-01)
-- ═══════════════════════════════════════════════════════════════════════════════════════════
--
-- Decisión de Keneth con el riesgo delante. Hasta hoy la carga se promovía sola y el cliente
-- veía el resultado; ahora ve PRIMERO lo que entendimos —hoja por hoja, con el dinero que cada
-- una aporta— y su contabilidad entra recién cuando dice que está bien.
--
-- El motivo no es desconfianza del modelo: es que los siete fallos de ingesta de esta semana
-- NO fueron filas dudosas. Fueron decisiones sobre HOJAS, tomadas con alta confianza y
-- equivocadas — una cartera de clientes leída como ingresos, un consolidado contado dos veces,
-- un presupuesto entrando como dinero real. Ninguna la habría atrapado una revisión por fila;
-- todas se ven de un vistazo en un resumen por hoja con su monto al lado.
--
-- ⚠️ EL RIESGO QUE ESTO REINTRODUCE, Y QUE SE ASUMIÓ A PROPÓSITO
--
-- La regla anterior a la migración 0020 era "nada entra hasta que la carga esté revisada", y
-- se midió lo que provocó: 0 filas en producción contra 3.195 esperando en staging. La
-- diferencia con aquello es de quién es el trabajo y cuánto cuesta — allá lo hacía STAFF de
-- Macha y era fila por fila; acá lo hace el DUEÑO de la contabilidad y son tres o cuatro
-- decisiones sobre su propio archivo. Aun así la forma es la misma, así que la mitigación es
-- que el portón sea imposible de no ver: banner en el Dashboard, correo con deep link, y la
-- carga listada como "esperando tu confirmación", nunca como si estuviera lista.
--
-- `confirmed_at` en vez de un estado nuevo: el estado dice en qué punto del PROCESO está la
-- carga y esto es una propiedad ortogonal —una carga puede estar esperando confirmación y
-- además tener filas marcadas—. Y `null` significa exactamente "todavía no", que es lo que
-- `promoteDocument` necesita preguntar.
ALTER TABLE documents ADD COLUMN IF NOT EXISTS confirmed_at timestamptz;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS confirmed_by uuid;

-- Las cargas que YA existían se dan por confirmadas: su dueño nunca tuvo la pantalla y
-- retenerles la contabilidad retroactivamente sería vaciarles el dashboard sin avisar.
UPDATE documents SET confirmed_at = COALESCE(promoted_at, updated_at)
WHERE confirmed_at IS NULL AND status IN ('promoted', 'reverted', 'review');

-- Se consulta "las que esperan al cliente" en cada carga del Dashboard.
CREATE INDEX IF NOT EXISTS documents_company_confirmed_idx
  ON documents (company_id, confirmed_at);

-- ⚠️ Y EL CHECK DEL ESTADO, que es exactamente lo que la migración 0041 dejó escrito hace
-- horas: `documents.status` es un tipo de TypeScript en el código y un CHECK en la base, y el
-- que manda es el CHECK. Sin ampliarlo, el worker falla al escribir `awaiting_confirmation`
-- DESPUÉS de haber procesado el archivo entero — la carga queda en `processing` para siempre y
-- el cliente ve una barra que no avanza. La 0018 y la 0026 hicieron lo mismo al agregar
-- `unsupported` y `cancelled`.
--
-- `awaiting_confirmation` es un estado propio y no `review` a propósito: `review` significa
-- "un humano de MACHA tiene que mirar esto" y alimenta la cola de `/admin`. Una carga recién
-- procesada que espera a su DUEÑO no es trabajo de staff, y mezclarlas haría que la cola
-- interna se llenara de cargas que no le tocan a nadie de Macha.
DO $$ BEGIN
  ALTER TABLE documents DROP CONSTRAINT IF EXISTS documents_status_chk;
  ALTER TABLE documents ADD CONSTRAINT documents_status_chk
    CHECK (status IN ('queued','processing','review','promoted','reverted','failed',
                      'unsupported','cancelled','awaiting_confirmation'));
END $$;
