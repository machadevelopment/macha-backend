-- Diccionario de CATEGORÍAS por empresa (acuerdo Keneth–Semi, 2026-08-20).
--
-- ═══ QUÉ PROBLEMA RESUELVE ═══
--
-- `company_column_profiles` (0027) ya guarda DÓNDE está cada dato: qué columna es la fecha,
-- cuál el monto. Eso hizo que el modelo deje de leer las 18.000 filas y devuelva el mapa una
-- vez por hoja.
--
-- Lo que sigue costando es CLASIFICAR: decidir que "pago a Claro" es servicios y "flete
-- Cropa" es transporte. Eso no lo puede sacar un parser del layout, porque no está en la
-- forma del archivo sino en el significado del texto — y es exactamente lo que se le sigue
-- preguntando al modelo carga tras carga, con las MISMAS respuestas.
--
-- Semi lo planteó así: que la clasificación sea "un 2-way street… así reducir la cantidad de
-- distintos y que eso se guarde para que el script futuro ya sea más directo". Esta tabla es
-- ese guardado.
--
-- ═══ LA IDEA ECONÓMICA, QUE ES EL PUNTO ═══
--
-- Un cliente sube su contabilidad cada semana y sus conceptos se repiten: los mismos
-- proveedores, los mismos rubros. La primera carga paga la clasificación; de la segunda en
-- adelante, cada concepto ya resuelto se responde en CÓDIGO y no cuesta un token.
--
-- El diccionario se vuelve más chico solo: no crece con las filas del archivo, crece con los
-- conceptos DISTINTOS del negocio, que son decenas y se estabilizan.
--
-- ═══ POR QUÉ EL CLIENTE ES PARTE DEL FLUJO ═══
--
-- Decisión de Semi, 2026-08-20: cuando queden conceptos que el modelo no logró clasificar, se
-- le muestran al CLIENTE durante la subida para que él los categorice, y de ahí en adelante
-- no se vuelve a preguntar. No es revisión interna: es la persona que sabe qué es "Cropa" en
-- su propio libro. Por eso `source` distingue quién lo decidió — lo del cliente vale más que
-- lo inferido, y el orden de lectura lo respeta.
--
-- ═══ APPEND-ONLY, COMO EL PERFIL DE COLUMNAS ═══
--
-- Y por el mismo motivo, no por simetría: una categoría equivocada manda plata al rubro
-- equivocado del dashboard sin que nada falle. Cuando el cliente pregunte "¿por qué mis
-- servicios subieron en marzo?", la única respuesta útil es "con esta regla se clasificó", y
-- solo existe si las versiones anteriores siguen ahí. Un UPDATE las borraría.
--
-- Idempotente: `migrate.ts` lleva registro por sha256, pero editar este archivo lo reaplica.

-- ---------------------------------------------------------------------------
-- 1) La tabla.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS company_category_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies (id),

  -- El CONCEPTO normalizado: el texto de la fila que dispara la regla, pasado por la misma
  -- normalización que usa el canonizador (minúsculas, sin acentos, sin puntuación, espacios
  -- colapsados). Ver src/lib/category-dictionary.ts.
  --
  -- Normalizado y NO crudo: "Pago a CLARO", "pago claro" y "Pago  a  Claro." son el mismo
  -- concepto para cualquiera que lo lea, y guardarlos como tres reglas distintas haría que el
  -- diccionario creciera sin aprender nada.
  concepto text NOT NULL,

  -- A qué se resuelve. `entity` y `type` van junto a la categoría porque una regla sin ellos
  -- es ambigua: "flete" puede ser un costo directo (traer mercadería) o un gasto operativo
  -- (mandar una muestra), y son rubros distintos del dashboard.
  entity text NOT NULL,
  type text,
  category text NOT NULL,

  -- Quién lo decidió. Es lo que resuelve el conflicto cuando hay dos reglas para el mismo
  -- concepto, y el orden NO es arbitrario:
  --   'confirmado_por_cliente' — lo dijo quien conoce su propio libro. Gana siempre.
  --   'corregido_por_staff'    — un operador lo arregló desde el backoffice.
  --   'inferido'               — lo dedujo el modelo en una carga.
  source text NOT NULL DEFAULT 'inferido',

  -- Versión dentro de (company_id, concepto). La vigente es la mayor con el `source` de más
  -- autoridad — ver la nota del índice de abajo.
  version integer NOT NULL,

  created_at timestamptz NOT NULL DEFAULT now(),

  -- Quién la creó, cuando fue una persona. NULL = la infirió la ingesta sola.
  -- Sin FK a `users`: una regla corregida por staff apunta a `staff`, no a `users`, y la
  -- trazabilidad de quién la tocó ya vive en `admin_audit_log`.
  created_by uuid,

  CONSTRAINT company_category_rules_source_ck
    CHECK (source IN ('inferido', 'confirmado_por_cliente', 'corregido_por_staff')),
  CONSTRAINT company_category_rules_version_ck CHECK (version >= 1),
  -- Un concepto vacío casaría con cualquier fila sin descripción y clasificaría media hoja
  -- por accidente. Se ataja en la base y no solo en la app.
  CONSTRAINT company_category_rules_concepto_ck CHECK (length(btrim(concepto)) > 0)
);

-- ---------------------------------------------------------------------------
-- 2) Índices.
-- ---------------------------------------------------------------------------
-- El UNIQUE es el árbitro real de que no haya dos versiones con el mismo número, no un
-- chequeo en la app: dos cargas simultáneas de la misma empresa pueden calcular
-- `max(version) + 1` a la vez y llegar al mismo número. Acá la segunda falla y reintenta.
CREATE UNIQUE INDEX IF NOT EXISTS company_category_rules_version_uq
  ON company_category_rules (company_id, concepto, version);

-- La consulta caliente es "todas las reglas vigentes de esta empresa", que se carga UNA vez
-- por documento y se resuelve en memoria — no una consulta por fila. Con 18.000 filas, una
-- consulta por fila serían 18.000 idas a la base para ahorrar llamadas al modelo, que es
-- cambiar un costo por otro.
CREATE INDEX IF NOT EXISTS company_category_rules_empresa_idx
  ON company_category_rules (company_id, concepto, version DESC);

-- ---------------------------------------------------------------------------
-- 3) RLS — tenant-scoped.
-- ---------------------------------------------------------------------------
-- Sin esto, la regla de una empresa podría clasificar la fila de otra. No sería solo fuga de
-- aislamiento: "pago a Claro = servicios" es cierto para una PYME y puede ser falso para la
-- de al lado, así que además corrompería su contabilidad en silencio.
--
-- `macha_asegurar_rls` y no un ALTER directo: el ALTER pide AccessExclusiveLock en CADA
-- deploy para no cambiar nada, y eso ya mató un deploy con deadlock (ver 0000_aa_rls_helpers).
SELECT macha_asegurar_rls('company_category_rules');

DROP POLICY IF EXISTS company_category_rules_tenant_isolation ON company_category_rules;

CREATE POLICY company_category_rules_tenant_isolation ON company_category_rules
  USING (
    company_id = nullif(current_setting('app.company_id', true), '')::uuid
    OR nullif(current_setting('app.cross_tenant', true), '') = 'on'
  );

-- ---------------------------------------------------------------------------
-- 4) Permisos del rol de aplicación.
-- ---------------------------------------------------------------------------
-- SELECT e INSERT, nunca UPDATE ni DELETE: es lo que hace REAL el append-only. Sin este
-- REVOKE la regla sería solo una convención que el próximo `db.update()` rompe sin avisar.
--
-- Y solo vale si la app conecta como `macha_app`: el DUEÑO de la tabla conserva UPDATE y
-- DELETE implícitos pase lo que pase (verificado — no existe un "FORCE" para privilegios como
-- sí lo hay para RLS). Ver migración 0010.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'macha_app') THEN
    GRANT SELECT, INSERT ON company_category_rules TO macha_app;
    REVOKE UPDATE, DELETE ON company_category_rules FROM macha_app;
  END IF;
END $$;

COMMENT ON TABLE company_category_rules IS
  'Diccionario de categorías por empresa (Keneth-Semi 2026-08-20). Concepto normalizado -> (entidad, tipo, categoría). Append-only: la regla vigente es la de mayor version, con el source de más autoridad. Hace que la segunda carga del mismo libro no vuelva a pagar la clasificación.';
