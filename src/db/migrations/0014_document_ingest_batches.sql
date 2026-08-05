-- CU-868kkgypv: marca de progreso por lote del worker de ingesta de Excel.
--
-- EL PROBLEMA. `excel.ingest` tiene retryLimit 3 (src/queue/index.ts) y el worker
-- relanzaba todo desde la primera hoja en cada reintento. Cada lote confirma su propia
-- transacción corta —deliberado, porque entre lotes hay llamadas de red lentas y no se
-- debe retener una conexión del pool durante minutos— así que los lotes ya hechos
-- sobrevivían al fallo del siguiente. Un fallo en la hoja 3 de 4 dejaba, al reintentar:
--
--   * `staging_rows` duplicadas -> `promoteDocument` las promueve todas sin distinguir
--     intentos -> transacciones, facturas y cuentas por pagar DOBLES;
--   * `credit_transactions` con el cobro repetido, sobre un ledger append-only que solo
--     se corrige con una fila compensatoria a mano;
--   * `ai_usage_events` con el costo duplicado — justo el dato con el que se va a fijar
--     el precio de los créditos (CU-868kfv97x);
--   * gasto real en Anthropic por reprocesar hojas ya procesadas.
--
-- Con retryLimit 3, un fallo persistente en la última hoja dejaba hasta 4 copias.
--
-- LA UNIDAD DE PROGRESO ES EL LOTE (hoja + índice). No la fila: Claude puede devolver
-- más o menos filas que las de entrada, así que no hay clave estable posición-a-posición.
-- No el documento: reintentar por documento vuelve a gastar todas las llamadas a Claude
-- ya pagadas. El lote es exactamente lo que consume una llamada, que es lo que no se
-- quiere repetir. Por eso el worker queda REANUDABLE, no solo idempotente.
--
-- El UNIQUE de abajo es el árbitro, no un "if not exists" en la app: la fila se inserta
-- en la MISMA transacción que las staging_rows, el débito y el ai_usage_events del lote.

CREATE TABLE IF NOT EXISTS document_ingest_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies (id),
  document_id uuid NOT NULL REFERENCES documents (id),
  sheet_name text NOT NULL,
  batch_index integer NOT NULL,
  row_count integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS document_ingest_batches_uq ON document_ingest_batches (
  company_id, document_id, sheet_name, batch_index
);

-- Mismo tratamiento que cualquier tabla de inquilino: RLS + FORCE (0010, que sujeta
-- también al dueño) + la política de 0013, que admite `app.company_id` o la vía de staff
-- `app.cross_tenant`. Sin esto la tabla nacería sin backstop y el panel admin no la vería.
-- `nullif(..., '')` es obligatorio: un GUC revertido al cerrar la transacción vale cadena
-- vacía, y `''::uuid` revienta en la siguiente request de esa conexión.
ALTER TABLE document_ingest_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_ingest_batches FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS document_ingest_batches_tenant_isolation ON document_ingest_batches;

CREATE POLICY document_ingest_batches_tenant_isolation ON document_ingest_batches
  USING (
    company_id = nullif(current_setting('app.company_id', true), '')::uuid
    OR nullif(current_setting('app.cross_tenant', true), '') = 'on'
  );

-- No es un ledger append-only: reprocesar un documento desde cero (p. ej. tras revertir)
-- tiene que poder limpiar sus marcas. Por eso NO se hace REVOKE de UPDATE/DELETE aquí.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'macha_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON document_ingest_batches TO macha_app;
  END IF;
END $$;
