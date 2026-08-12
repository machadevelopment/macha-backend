-- Tokens de CACHÉ en el ledger de consumo de IA.
--
-- POR QUÉ. `ai_usage_events` guardaba `input_tokens` y `output_tokens`, y con eso la
-- pregunta "¿el caché de prompt está pegando?" no tenía respuesta numérica — solo se podía
-- contestar leyendo el código y confiando. El bloque de sinónimos y ejemplos va marcado
-- `cache_control: ephemeral` desde CU-868kfva91, pero nadie ha medido nunca si acierta.
--
-- Y PASÓ A IMPORTAR. Hasta el 2026-08-12 la entrada era el 4,3 % del recibo (USD 1,95 de
-- 45,26) y medir el caché era curiosidad. Al achicar el esquema de salida, la salida cayó
-- un 86 % y la entrada quedó siendo ~un tercio del costo; además el presupuesto de salida
-- más chico multiplicó por tres las llamadas por documento, y el prefijo de sistema se
-- re-envía en cada una. El caché dejó de ser un detalle.
--
-- ═══ ADEMÁS ARREGLA UN SUBCONTEO REAL, NO SOLO AGREGA UNA MÉTRICA ═══
--
-- `usage.input_tokens` de la API NO incluye los tokens servidos desde caché ni los que se
-- escribieron al crearla: la API los reporta aparte, en `cache_read_input_tokens` y
-- `cache_creation_input_tokens`. Como el ledger solo guardaba `input_tokens`, todo lo que
-- entró por caché se estaba costeando como CERO.
--
-- O sea que `cost_usd` venía subestimado desde que existe el bloque cacheable — hacia el
-- lado peligroso, que es el mismo que motivó las tarifas con vigencia de CU-868kjc9d6:
-- creer que la IA sale más barata de lo que sale. Las filas viejas no se corrigen (el
-- ledger es append-only, las correcciones son filas compensatorias); de acá en adelante
-- el número es completo.
--
-- Ambas columnas van NOT NULL DEFAULT 0: las filas históricas quedan en 0, que es
-- honesto — no es que hubiera cero caché, es que no se midió. La distinción se documenta
-- en el COMMENT para que nadie lea un promedio histórico como si fuera una tasa de acierto.
--
-- Idempotente como todas: `migrate.ts` aplica CADA archivo en CADA invocación.

ALTER TABLE ai_usage_events
  ADD COLUMN IF NOT EXISTS cache_read_input_tokens integer NOT NULL DEFAULT 0;

ALTER TABLE ai_usage_events
  ADD COLUMN IF NOT EXISTS cache_creation_input_tokens integer NOT NULL DEFAULT 0;

COMMENT ON COLUMN ai_usage_events.cache_read_input_tokens IS
  'Tokens servidos desde el caché de prompt (se cobran a 0,1x). NO están incluidos en '
  'input_tokens: la API los reporta aparte. 0 en filas anteriores al 2026-08-12 significa '
  '"no se midió", no "no hubo caché".';

COMMENT ON COLUMN ai_usage_events.cache_creation_input_tokens IS
  'Tokens escritos al crear el caché de prompt (se cobran a 1,25x). NO están incluidos en '
  'input_tokens. 0 en filas anteriores al 2026-08-12 significa "no se midió".';

-- El ledger es append-only (CLAUDE.md). `macha_app` conserva solo SELECT + INSERT sobre las
-- columnas nuevas igual que sobre las viejas; el GRANT es a nivel de tabla, así que no hay
-- nada que re-otorgar. Se deja constancia para que no se busque el GRANT faltante.
