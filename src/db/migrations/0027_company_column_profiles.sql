-- Perfil de mapeo de columnas POR EMPRESA (CU-868krmrcj · ARCHITECTURE 6.3.11 y 6.3.12).
--
-- ═══ QUÉ PROBLEMA RESUELVE ═══
--
-- Hoy el único molde para leer el Excel de un cliente es la plantilla de su INDUSTRIA. Eso
-- es demasiado grueso para la contabilidad de una PYME, que tiene encabezados propios. Los
-- logs de producción del 2026-08-14 lo muestran directo:
--
--   company=b36951ad… industry="candelas" sin plantilla propia: usando la genérica integrada
--
-- Esa empresa se está clasificando con el molde genérico porque su industria no tiene
-- plantilla, y no hay forma de que el sistema aprenda cómo son SUS archivos.
--
-- El perfil es esa capa que falta: por empresa, por estructura de hoja, el mapa de columnas
-- que ya se resolvió una vez.
--
-- ═══ CONVIVE CON LA PLANTILLA GLOBAL, NO LA REEMPLAZA ═══
--
-- Punto 6.3.11, textual: "override de mapeo versionado por company_id que baja los flags sin
-- ensuciar la plantilla global". Esta tabla NO toca `industry_templates` ni sus versiones. La
-- plantilla sigue siendo el molde por industria; el perfil es lo que esta empresa concreta ya
-- demostró que trae. Si el perfil no aplica, la plantilla sigue ahí.
--
-- ═══ APPEND-ONLY Y VERSIONADO ═══
--
-- Como el resto de los ledgers del sistema. Un perfil no se edita: se agrega una versión
-- nueva y la vigente es la de mayor `version` para ese par (empresa, estructura).
--
-- La razón no es simetría: un mapa de columnas equivocado desplaza TODA la contabilidad de
-- una hoja hacia la columna de al lado, con datos plausibles y sin un solo error. Cuando eso
-- pase —y va a pasar— la única pregunta útil es "¿con qué mapa se leyó la carga del martes?",
-- y solo se puede contestar si las versiones anteriores siguen ahí. Un UPDATE las borraría.
--
-- Idempotente: `migrate.ts` lleva registro por sha256, pero editar este archivo lo reaplica.

-- ---------------------------------------------------------------------------
-- 1) La tabla.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS company_column_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies (id),

  -- sha256 hex de los encabezados NORMALIZADOS y en orden — ver src/lib/header-hash.ts.
  -- `char(64)` y no `text` por la misma razón que en `ingested_rows`: la longitud es fija por
  -- construcción y el tipo lo documenta.
  header_hash char(64) NOT NULL,

  -- Los encabezados normalizados que produjeron ese hash, en orden.
  --
  -- REDUNDANTE CON EL HASH Y A PROPÓSITO. El hash contesta "¿es el mismo layout?" pero no se
  -- puede leer. El día que el perfil de una empresa deje de calzar, esto es lo único que
  -- permite comparar el archivo nuevo contra el que originó el perfil sin adivinar.
  headers jsonb NOT NULL,

  -- Informativo, NO parte de la identidad: la misma tabla exportada como "Ventas" o
  -- "Ventas 2026" es el mismo layout, y meter el nombre en la llave daría un perfil nuevo
  -- cada año. Sirve para que un operador reconozca de qué hoja habla el perfil.
  sheet_name text,

  -- El ColumnMap de src/lib/row-assembly.ts: índice de columna por campo canónico.
  column_map jsonb NOT NULL,

  -- De dónde salió este mapa. Importa para decidir a quién creerle cuando hay conflicto:
  -- lo que confirmó el cliente o corrigió el staff gana sobre lo que infirió el modelo.
  --   'inferido'               — lo dedujo el modelo durante una carga.
  --   'confirmado_por_cliente' — el cliente lo validó en el onboarding (fase C).
  --   'corregido_por_staff'    — un operador lo arregló desde el backoffice.
  source text NOT NULL DEFAULT 'inferido',

  -- Versión dentro de (company_id, header_hash). La vigente es la mayor.
  version integer NOT NULL,

  created_at timestamptz NOT NULL DEFAULT now(),

  -- Quién lo creó, cuando fue una persona. NULL = lo infirió la ingesta sola.
  -- Sin FK a `users` a propósito: un perfil corregido por staff apunta a `staff`, no a
  -- `users`, y la trazabilidad de quién lo tocó ya vive en `admin_audit_log`.
  created_by uuid,

  CONSTRAINT company_column_profiles_source_ck
    CHECK (source IN ('inferido', 'confirmado_por_cliente', 'corregido_por_staff')),
  CONSTRAINT company_column_profiles_version_ck CHECK (version >= 1)
);

-- ---------------------------------------------------------------------------
-- 2) Índices.
-- ---------------------------------------------------------------------------
-- El UNIQUE es el árbitro real de que no haya dos versiones con el mismo número, no un
-- chequeo en la app: dos cargas simultáneas de la misma empresa pueden calcular
-- `max(version) + 1` a la vez y llegar al mismo número. Acá la segunda falla y reintenta.
CREATE UNIQUE INDEX IF NOT EXISTS company_column_profiles_version_uq
  ON company_column_profiles (company_id, header_hash, version);

-- La consulta caliente: "el perfil vigente de esta empresa para esta estructura".
-- `version DESC` en el índice para que el `ORDER BY … LIMIT 1` sea un salto, no un sort.
CREATE INDEX IF NOT EXISTS company_column_profiles_vigente_idx
  ON company_column_profiles (company_id, header_hash, version DESC);

-- ---------------------------------------------------------------------------
-- 3) RLS — tenant-scoped.
-- ---------------------------------------------------------------------------
-- Sin esto, el perfil de una empresa podría aplicarse a la hoja de otra: el mapa de columnas
-- equivocado no falla, lee la columna de al lado. Sería fuga de aislamiento Y corrupción
-- silenciosa de la contabilidad del cliente, en el mismo movimiento.
--
-- `macha_asegurar_rls` y no un ALTER directo: el ALTER pide AccessExclusiveLock en CADA
-- deploy para no cambiar nada, y eso ya mató un deploy con deadlock (ver 0000_aa_rls_helpers).
SELECT macha_asegurar_rls('company_column_profiles');

DROP POLICY IF EXISTS company_column_profiles_tenant_isolation ON company_column_profiles;

CREATE POLICY company_column_profiles_tenant_isolation ON company_column_profiles
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
    GRANT SELECT, INSERT ON company_column_profiles TO macha_app;
    REVOKE UPDATE, DELETE ON company_column_profiles FROM macha_app;
  END IF;
END $$;
