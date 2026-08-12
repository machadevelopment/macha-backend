-- Huellas de filas ya ingeridas, para deduplicar ANTES de llamar a la IA.
--
-- POR QUÉ EXISTE. Un cliente exporta su contabilidad completa y la sube cada semana: la
-- semana 2 son las mismas 5.000 filas más 200 nuevas. Hasta ahora el sistema le mandaba las
-- 5.200 a Claude y se pagaba por 5.000 filas ya procesadas. Con el reparto de costo medido
-- el 2026-08-12 (95,7 % del recibo son tokens de SALIDA), reprocesar una fila conocida es
-- literalmente tirar dinero por cada una.
--
-- LO QUE YA EXISTÍA NO CUBRE ESTE CASO, y la distinción es la clave del cambio:
--   · `document_ingest_batches` evita reprocesar el MISMO documento (un reintento).
--   · `staging_rows.promoted_at` evita promover dos veces la MISMA fila de staging.
-- Las dos protegen contra repetir un documento. Ninguna protege contra un documento NUEVO
-- que contiene filas viejas — que es el caso semanal y el único que cuesta dinero.
--
-- Y deduplicar al INSERTAR tampoco habría servido: si la fila ya se le mandó a Claude, ya se
-- pagó, aunque después no se inserte. Por eso esta tabla se consulta ANTES de clasificar.
--
-- Idempotente como todas: `migrate.ts` aplica CADA archivo en CADA invocación.

-- ---------------------------------------------------------------------------
-- 1) La tabla.
-- ---------------------------------------------------------------------------
-- `fingerprint` es sha256 en hex (64 caracteres) de (company_id, hoja, celdas
-- normalizadas, ordinal de aparición) — ver `src/lib/row-fingerprint.ts`, que documenta por
-- qué lleva ordinal: dos ventas iguales el mismo día NO son un duplicado, y una huella solo
-- de contenido las colapsaría perdiendo una venta real del cliente.
--
-- `char(64)` y no `text`: la longitud es fija por construcción y el tipo lo documenta.
CREATE TABLE IF NOT EXISTS ingested_rows (
  company_id uuid NOT NULL REFERENCES companies (id),
  fingerprint char(64) NOT NULL,
  -- Documento donde se vio por PRIMERA vez. Es trazabilidad, no identidad: la huella no
  -- depende de él (si dependiera, cada archivo nuevo daría huellas nuevas y no se
  -- deduplicaría nada). Sirve para responder "¿de qué carga salió esta fila?".
  first_seen_document_id uuid NOT NULL REFERENCES documents (id),
  sheet_name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- La PK es el par (empresa, huella): es la consulta que se hace y garantiza que una
  -- huella no se registre dos veces para la misma empresa.
  PRIMARY KEY (company_id, fingerprint)
);

-- ---------------------------------------------------------------------------
-- 2) RLS — esta tabla SÍ es tenant-scoped.
-- ---------------------------------------------------------------------------
-- A diferencia de `plans` (catálogo global, migración 0021), acá cada fila pertenece a una
-- empresa. Sin RLS, una consulta mal escrita podría contar las huellas de otra empresa y
-- hacer que sus filas se saltaran la IA — que además de fuga de aislamiento sería pérdida
-- de datos: las filas del cliente nunca se procesarían.
ALTER TABLE ingested_rows ENABLE ROW LEVEL SECURITY;
ALTER TABLE ingested_rows FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ingested_rows_tenant_isolation ON ingested_rows;

CREATE POLICY ingested_rows_tenant_isolation ON ingested_rows
  USING (
    company_id = nullif(current_setting('app.company_id', true), '')::uuid
    OR nullif(current_setting('app.cross_tenant', true), '') = 'on'
  );

-- ---------------------------------------------------------------------------
-- 3) Permisos del rol de aplicación.
-- ---------------------------------------------------------------------------
-- La app corre como `macha_app` (migración 0010). Sin DELETE a propósito: revertir una
-- carga (soft-delete por `document_id`) NO debe borrar huellas. Si las borrara, volver a
-- subir el archivo revertido lo reprocesaría entero y se pagaría dos veces — justo lo que
-- esta tabla existe para evitar. Una huella es "esta fila ya se le mostró al modelo", y eso
-- no deja de ser cierto porque después se haya revertido la promoción.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'macha_app') THEN
    GRANT SELECT, INSERT ON ingested_rows TO macha_app;
  END IF;
END $$;
