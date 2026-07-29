-- CU-868kh8uau — `chats.report_version_id` guardaba un `reports.id`.
--
-- El bug: `report-detail.tsx` mandaba el id del REPORTE en el campo que dice contener
-- el id de la VERSIÓN. Como la columna no tenía FK, Postgres aceptaba la referencia
-- falsa sin chistar y el origen del hilo (US-14) quedaba mal registrado en silencio.
-- El fix del cliente por sí solo no impide que vuelva a pasar: esta migración pone la
-- garantía donde no se puede eludir.
--
-- FK COMPUESTA, no simple (regla no negociable de CLAUDE.md: las referencias
-- cross-tenant incluyen company_id). Con `(company_id, report_version_id)` apuntando a
-- `(company_id, id)`, referenciar la versión de OTRA empresa es imposible a nivel de
-- base, no solo por convención. Una FK simple contra `report_versions(id)` habría
-- atrapado el bug original pero habría dejado abierta esa segunda puerta.
--
-- `report_versions` NO está particionada (verificado: `id` es PK propia, `company_id`
-- está denormalizado para scoping) — la nota del ticket sobre "partición-consciente"
-- no aplica aquí, así que la FK compuesta es directa y no necesita tratamiento
-- especial de particiones. Lo único que hace falta es el índice único que le da
-- destino.
--
-- MATCH SIMPLE (el default) es deliberado: `report_version_id` es NULL en todo hilo
-- que NO nació de un deep-link, y con MATCH SIMPLE la constraint no se evalúa si
-- alguna columna es NULL. Con MATCH FULL, cada chat normal violaría la FK.

-- 1) Limpieza previa. Las filas existentes con una referencia inválida son
--    exactamente el bug — sin esto, el ALTER de abajo falla y tumba el deploy (las
--    migraciones auto-aplican). `chats` no es un ledger append-only, así que el UPDATE
--    es legítimo aquí; se dejan en NULL, que es el estado honesto: "este hilo no tiene
--    un origen de reporte confiable". Idempotente por construcción.
UPDATE chats c
SET report_version_id = NULL
WHERE c.report_version_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM report_versions rv
    WHERE rv.id = c.report_version_id
      AND rv.company_id = c.company_id
  );

-- 2) Destino de la FK. `id` ya es único por sí solo (es la PK), pero una FK compuesta
--    exige un índice único sobre EXACTAMENTE las columnas referenciadas.
CREATE UNIQUE INDEX IF NOT EXISTS report_versions_company_id_uq
  ON report_versions (company_id, id);

-- 3) La FK. Guardada por pg_constraint porque este archivo se re-aplica en cada deploy.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chats_report_version_fk'
  ) THEN
    ALTER TABLE chats
      ADD CONSTRAINT chats_report_version_fk
      FOREIGN KEY (company_id, report_version_id)
      REFERENCES report_versions (company_id, id);
  END IF;
END $$;
