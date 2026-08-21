-- Plantilla de Excel DESCARGABLE por industria (pedido de Jose, 2026-08-20).
--
-- ═══ QUÉ PROBLEMA RESUELVE, Y QUÉ NO ═══
--
-- Jose: "el equipo de Macha debe poder cargar diferentes plantillas por tipo de industria,
-- para que los usuarios que no tengan un Excel establecido puedan descargarla en el
-- onboarding".
--
-- La DESCARGA ya existía: `/industry-templates/download` genera un .xlsx al vuelo con las
-- categorías canónicas del diccionario de la industria de la empresa. Sirve para enseñar qué
-- columnas llenar, y por eso nunca da un enlace roto.
--
-- Lo que no existía es que una persona pueda subir un archivo CURADO — uno con hojas de
-- verdad, ejemplos con sentido para una cafetería o una consultora, un formato pensado. Eso no
-- se puede generar: es contenido.
--
-- ═══ POR QUÉ UNA TABLA NUEVA Y NO UNA COLUMNA EN `industry_template_versions` ═══
--
-- Son dos cosas distintas que comparten la palabra "plantilla":
--
--   · `industry_template_versions` (synonyms + few_shot) le ENSEÑA A LA IA a leer el Excel que
--     el cliente YA tiene. Nunca la ve una persona.
--   · esto es UN ARCHIVO PARA EL CLIENTE, para cuando no tiene ningún Excel.
--
-- Mezclarlas obligaría a versionar juntas dos cosas que cambian por motivos independientes:
-- agregar un sinónimo de columna crearía una versión nueva del material de la IA Y arrastraría
-- el archivo, o al revés — subir un .xlsx nuevo forzaría una versión del diccionario que nadie
-- pidió, y la ingesta reclasificaría con un "cambio" que no cambió nada.
--
-- ═══ APPEND-ONLY CON VERSIÓN ═══
--
-- La vigente es la de mayor `version`. Tres razones concretas, en orden de peso:
--
--   1. El binario vive en S3 y la fila solo guarda su clave. Un UPDATE dejaría el objeto
--      anterior huérfano en el bucket: nadie lo referencia y nadie lo borra.
--   2. Se puede volver atrás. Si alguien sube un archivo mal armado, la corrección es subir el
--      anterior de nuevo, no recuperar algo que se sobreescribió.
--   3. Es lo que hace su tabla hermana. Que dos tablas con la misma forma se comporten
--      distinto es deuda que se paga cada vez que alguien lee una y asume la otra.
--
-- La tabla es de PLATAFORMA, no de un tenant: la plantilla de "retail" es la misma para todos
-- los clientes de retail. Por eso NO lleva `company_id` ni RLS — ver el bloque 3.
--
-- Idempotente: `migrate.ts` lleva registro por sha256, pero editar este archivo lo reaplica.

-- ---------------------------------------------------------------------------
-- 1) La tabla.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS industry_starter_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- La industria, como texto libre y NO como FK a `industry_templates`.
  --
  -- `companies.industry` es texto libre y es contra ESO que hay que casar: una empresa puede
  -- tener una industria para la que todavía no existe material de IA, y negarle la plantilla
  -- descargable por eso sería atar dos cosas que este archivo separa a propósito.
  industry text NOT NULL,

  -- Solo la CLAVE de S3: el binario nunca entra a la base (regla no negociable del proyecto).
  s3_key text NOT NULL,

  -- El nombre con el que se subió, que es el que el cliente ve al descargar. Sin esto habría
  -- que inventarle un nombre a un archivo que alguien nombró a propósito.
  original_filename text NOT NULL,
  file_size_bytes integer NOT NULL,
  content_type text NOT NULL,

  -- Nota opcional del staff que la subió: "actualizada con el catálogo 2026", "pedida por
  -- Ventas". Es lo que hace revisable una lista de versiones dentro de seis meses.
  notes text,

  version integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),

  -- `staff.id` de quien la subió. Sin FK por el mismo motivo que `company_category_rules`: la
  -- trazabilidad de quién la tocó vive en `admin_audit_log`, que es el ledger de eso.
  created_by uuid,

  CONSTRAINT industry_starter_templates_version_ck CHECK (version >= 1),
  CONSTRAINT industry_starter_templates_industry_ck CHECK (length(btrim(industry)) > 0),
  CONSTRAINT industry_starter_templates_size_ck CHECK (file_size_bytes > 0)
);

-- ---------------------------------------------------------------------------
-- 2) Índices.
-- ---------------------------------------------------------------------------
-- El UNIQUE es el árbitro de que no haya dos versiones con el mismo número, no un chequeo en
-- la app: dos subidas simultáneas de la misma industria pueden calcular `max(version) + 1` a la
-- vez y llegar al mismo número. Acá la segunda falla y reintenta.
CREATE UNIQUE INDEX IF NOT EXISTS industry_starter_templates_version_uq
  ON industry_starter_templates (industry, version);

-- La consulta caliente es una sola: "la vigente de esta industria", en cada descarga.
CREATE INDEX IF NOT EXISTS industry_starter_templates_vigente_idx
  ON industry_starter_templates (industry, version DESC);

-- ---------------------------------------------------------------------------
-- 3) NADA DE RLS ACÁ, Y ES DELIBERADO.
-- ---------------------------------------------------------------------------
-- Toda tabla de negocio de este proyecto va scoped por `company_id` con RLS. Esta no, porque no
-- es de negocio: es catálogo de plataforma, igual que `industry_templates` y `plans`. La
-- plantilla de "retail" es la misma para todos los clientes de retail y no contiene ni un dato
-- de ninguno.
--
-- Ponerle RLS por simetría sería peor que no ponérselo: la política necesitaría un
-- `app.company_id` que esta consulta no tiene por qué conocer, y el resultado sería una tabla
-- que se lee vacía desde el camino del cliente — la plantilla dejaría de descargarse sin que
-- nada falle.
--
-- Lo que SÍ la protege es el guard: `/admin/*` exige `staff`, y el cliente solo llega por
-- `/industry-templates/download`, que resuelve la industria desde SU empresa y nunca acepta
-- una industria por parámetro.

-- ---------------------------------------------------------------------------
-- 4) Permisos del rol de aplicación.
-- ---------------------------------------------------------------------------
-- SELECT e INSERT, nunca UPDATE ni DELETE: es lo que hace REAL el append-only. Sin el REVOKE
-- la regla sería una convención que el próximo `db.update()` rompe sin avisar.
--
-- Solo vale si la app conecta como `macha_app`: el DUEÑO de la tabla conserva UPDATE y DELETE
-- implícitos pase lo que pase (no existe un "FORCE" para privilegios como sí lo hay para RLS).
-- Ver migración 0010.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'macha_app') THEN
    GRANT SELECT, INSERT ON industry_starter_templates TO macha_app;
    REVOKE UPDATE, DELETE ON industry_starter_templates FROM macha_app;
  END IF;
END $$;

COMMENT ON TABLE industry_starter_templates IS
  'Archivo .xlsx descargable por industria, subido por staff, para el cliente que no tiene ningun Excel armado (Jose 2026-08-20). Distinta de industry_template_versions, que es el material que le ensena a la IA a leer el archivo que el cliente YA tiene. Append-only: la vigente es la de mayor version.';
