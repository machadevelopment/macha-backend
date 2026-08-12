-- Reportes a demanda: `reports.frequency` admite 'on_demand'.
--
-- POR QUÉ HACE FALTA. `0003_checks.sql` fijó `reports_frequency_chk CHECK (frequency IN
-- ('daily','weekly'))` cuando el único productor de reportes era el tick diario
-- (`queue/workers/report-tick.ts`). Un reporte que el usuario pide desde la aplicación no
-- es ninguna de las dos: no tiene periodicidad, tiene una fecha de pedido y un rango
-- elegido a mano.
--
-- POR QUÉ NO SE REUSA 'daily'. `generateReport` busca-o-crea la fila de `reports` por
-- (company_id, period_start, period_end). Si un reporte a demanda sobre el 5 de agosto
-- entrara como 'daily', se colgaría como una VERSIÓN MÁS del reporte automático de ese
-- mismo día — y `report_versions` es append-only, así que esa mezcla no se puede deshacer
-- después. Peor: el reporte a demanda lleva secciones e instrucciones elegidas por el
-- usuario, y quedaría presentado como si fuera la evolución del automático. La frecuencia
-- entra en la clave de búsqueda justamente para que los dos convivan sin pisarse.
--
-- El tick diario NO cambia: sigue generando 'daily' todos los días (decisión explícita
-- del ticket B2). Esto solo agrega un tercer valor legítimo.
--
-- Idempotente por DROP + ADD y no por el `DO $$ ... EXCEPTION WHEN duplicate_object`
-- del resto del repo: aquí no se está creando una restricción nueva, se está SUSTITUYENDO
-- una que ya existe con otro cuerpo, y ese patrón se tragaría el cambio en silencio
-- (la restricción vieja seguiría vigente y todo INSERT 'on_demand' fallaría en runtime).
-- `migrate.ts` reaplica cada archivo en cada invocación, así que el DROP lleva IF EXISTS.
ALTER TABLE reports DROP CONSTRAINT IF EXISTS reports_frequency_chk;
ALTER TABLE reports ADD CONSTRAINT reports_frequency_chk
  CHECK (frequency IN ('daily', 'weekly', 'on_demand'));

COMMENT ON COLUMN reports.frequency IS
  'Cómo nació este reporte: daily/weekly = tick automático (queue/workers/report-tick.ts); '
  'on_demand = lo pidió un usuario desde la app, con su propio rango y sus propias secciones.';
