-- Frecuencia de reportes automáticos POR EMPRESA — CU-868kjc7t0.
--
-- QUÉ FALTABA. `report-tick.ts` documentaba su propia simplificación: "por ahora el tick
-- genera un reporte 'daily' para cada empresa activa, todos los días". No había preferencia
-- que respetar porque no había dónde guardarla. Consecuencias medidas en el ticket:
-- US-12 ("se respeta la frecuencia configurada") incumplido, `empresas_activas × 365`
-- llamadas a Claude al año las pida alguien o no, débito futuro de créditos por trabajo no
-- solicitado (`report_generation` tiene regla activa en `credit_rules`) y un email diario a
-- todo owner/admin con `receives_reports` — la vía más rápida a que marquen a Macha como
-- spam.
--
-- POR QUÉ EN `companies` Y NO EN `reports`. `reports.frequency` ya existe y guarda con qué
-- frecuencia se generó CADA reporte ya creado: es histórico inmutable de lo que pasó, no
-- configuración de lo que debe pasar. Meter la preferencia ahí obligaría a leer la última
-- fila para saber qué quiere la empresa, y una empresa en `off` —que por definición deja de
-- producir filas— no tendría dónde expresarlo. Son dos cosas distintas y conviven: el
-- histórico no se pierde al introducir la preferencia.
--
-- POR QUÉ EL DEFAULT ES 'weekly'. Criterio 1 del ticket: recibir un correo con una llamada a
-- IA todos los días es una decisión que el cliente debe tomar activamente, no heredar. El
-- DEFAULT también BACKFILLEA a las empresas existentes, que hoy reciben diario — es el
-- efecto buscado, no un daño colateral: es exactamente la conducta que el ticket viene a
-- cortar, y cualquiera que quiera diario lo activa desde Ajustes de empresa.
--
-- Idempotente como todas: migrate.ts reaplica CADA archivo en CADA invocación.

-- Sin partición aquí: `companies` es la tabla-ancla del aislamiento, de baja cardinalidad y
-- no particionada (data model §4.1), así que un ALTER TABLE normal alcanza. Y como la
-- columna es NOT NULL CON default constante, Postgres ≥11 no reescribe la tabla.
ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS report_frequency text NOT NULL DEFAULT 'weekly';

-- Enum por CHECK, como el resto de los "enums" del modelo (base_currency, status, locale).
-- DROP + ADD y no `DO $$ ... EXCEPTION WHEN duplicate_object`: si algún día se agrega un
-- valor (p. ej. 'monthly'), ese patrón se tragaría el cambio en silencio y dejaría vigente
-- la restricción vieja — el mismo razonamiento que dejó escrito la migración 0022.
ALTER TABLE companies DROP CONSTRAINT IF EXISTS companies_report_frequency_chk;
ALTER TABLE companies ADD CONSTRAINT companies_report_frequency_chk
  CHECK (report_frequency IN ('daily', 'weekly', 'off'));

COMMENT ON COLUMN companies.report_frequency IS
  'Preferencia de reportes AUTOMÁTICOS de esta empresa: daily = uno por el día anterior; '
  'weekly = uno los lunes (UTC) por la semana calendario anterior; off = ninguno. La lee '
  'queue/workers/report-tick.ts vía lib/report-schedule.ts. No confundir con '
  'reports.frequency, que es el histórico de cómo nació cada reporte ya creado. Los '
  'reportes a demanda (POST /reports/generate) no dependen de este campo.';

-- La app corre como macha_app (0010) y ya tiene UPDATE sobre `companies` — el owner/admin
-- edita su preferencia y staff la edita desde el admin. No hace falta GRANT nuevo: los
-- privilegios son por tabla, no por columna, y la columna nace dentro de una tabla que ya
-- los tiene.
