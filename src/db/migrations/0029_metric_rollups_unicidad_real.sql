-- El índice único de `metric_rollups` no impedía NADA para las filas que el producto escribe.
--
-- ═══ EL BUG (reportado por Jose, 2026-08-14) ═══
--
-- Síntoma textual: *"en 2 users diferentes sale diferente el display de la data, no sé si es
-- por el caché"*. La intuición era correcta.
--
-- `metric_rollups_uq` es UNIQUE (company_id, granularity, period, type, category). Pero
-- `category` es NULLABLE, y en Postgres **NULL nunca colisiona en un índice único**: dos filas
-- con category NULL y todo lo demás igual se consideran distintas y las dos entran.
--
-- Y `category IS NULL` son las ÚNICAS filas que el producto escribe hoy — el rollup por
-- categoría está definido pero sin usar (`lib/rollups.ts`). O sea que el índice que debía
-- garantizar una fila por (empresa, mes, tipo) no garantizaba nada en el 100 % de los casos.
--
-- ═══ CÓMO SE MANIFIESTA ═══
--
-- Dos usuarios de la misma empresa abren el dashboard a la vez. Los dos ven el caché vacío
-- para un período, los dos lo calculan, los dos insertan. Desde ese momento hay dos filas para
-- el mismo (mes, tipo).
--
-- A partir de ahí:
--   · Cada lectura devuelve la que Postgres le dé primero → dos usuarios, dos cifras.
--   · `refreshExistingRollups` hace select-then-update y actualiza UNA sola → la otra se queda
--     con el valor viejo PARA SIEMPRE. Cargar datos nuevos deja de reflejarse.
--
-- Reproducido contra Postgres real en `tests/integration/ingesta-revert-y-cache.test.ts`: dos
-- lecturas concurrentes dejaron 8 filas duplicadas, y tras una carga nueva la lectura seguía
-- devolviendo 1000 en vez de 1500.
--
-- ═══ EL ARREGLO ═══
--
-- Un índice único PARCIAL sobre `WHERE category IS NULL`. En un índice parcial las filas que
-- cumplen el predicado sí compiten entre sí por las columnas listadas, así que (empresa,
-- granularidad, período, tipo) pasa a ser único de verdad para las filas del producto.
--
-- El índice viejo se conserva: sigue siendo correcto para las filas CON categoría, el día que
-- se usen.

-- ---------------------------------------------------------------------------
-- 1) Limpiar los duplicados que ya existan, o el índice no se puede crear.
-- ---------------------------------------------------------------------------
-- Se conserva la fila calculada MÁS RECIENTE de cada grupo (`computed_at` desc, y `id` como
-- desempate estable). Es la que refleja el último estado del ledger: quedarse con la más vieja
-- perpetuaría exactamente el valor obsoleto que causó el reporte.
--
-- Va antes del índice y en la misma migración a propósito: entre ambas sentencias no puede
-- entrar una carga nueva, porque el `CREATE UNIQUE INDEX` toma su lock sobre una tabla que ya
-- quedó limpia.
DELETE FROM metric_rollups m
WHERE m.category IS NULL
  AND EXISTS (
    SELECT 1 FROM metric_rollups otra
    WHERE otra.category IS NULL
      AND otra.company_id  = m.company_id
      AND otra.granularity = m.granularity
      AND otra.period      = m.period
      AND otra.type        = m.type
      AND (otra.computed_at, otra.id) > (m.computed_at, m.id)
  );

-- ---------------------------------------------------------------------------
-- 2) La unicidad de verdad.
-- ---------------------------------------------------------------------------
-- `IF NOT EXISTS` lo hace idempotente. NO se usa `CONCURRENTLY`: no puede correr dentro de la
-- transacción del migrador, y esta tabla es de agregados por empresa —miles de filas, no
-- millones—, así que el lock es breve. Ver la nota de `schema_migrations` en CLAUDE.md sobre
-- por qué importa que las migraciones no pidan locks largos.
CREATE UNIQUE INDEX IF NOT EXISTS metric_rollups_sin_categoria_uq
  ON metric_rollups (company_id, granularity, period, type)
  WHERE category IS NULL;

COMMENT ON INDEX metric_rollups_sin_categoria_uq IS
  'Unicidad REAL de los rollups del producto. El índice metric_rollups_uq incluye category, que es nullable, y en Postgres NULL no colisiona — así que no impedía duplicados en las únicas filas que se escriben. Ver migración 0029.';
