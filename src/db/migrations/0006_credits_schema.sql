-- CU-868kfv97x: motor de reglas de créditos versionado (Jose: la forma del consumo se
-- decide ahora, los números no).
--
-- `credit_rules` ya existe desde 0000_peaceful_mandroid.sql (drizzle-kit generate SÍ
-- corre en este entorno vía `bun node_modules/drizzle-kit/bin.cjs generate`, evitando
-- el mismatch de arquitectura de esbuild al invocarlo por `node`) — pero drizzle no
-- puede expresar CHECK constraints, así que esos siguen a mano aquí, como ALTER TABLE
-- separado en vez de inline: un `CREATE TABLE IF NOT EXISTS` con CHECKs inline se
-- saltaría TODO el statement (CHECKs incluidos) si la tabla ya existe.
DO $$ BEGIN
  ALTER TABLE credit_rules ADD CONSTRAINT credit_rules_action_chk CHECK (action_kind IN ('excel','chat','insight','report_generation'));
EXCEPTION WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
  ALTER TABLE credit_rules ADD CONSTRAINT credit_rules_type_chk CHECK (rule_type IN ('fixed','variable'));
EXCEPTION WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
  ALTER TABLE credit_rules ADD CONSTRAINT credit_rules_unit_chk CHECK (unit IS NULL OR unit IN ('execution','batch','sheet','row'));
EXCEPTION WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
  ALTER TABLE credit_rules ADD CONSTRAINT credit_rules_credits_chk CHECK (credits_per_unit > 0);
EXCEPTION WHEN duplicate_object THEN null;
END $$;

ALTER TABLE credit_transactions ADD COLUMN IF NOT EXISTS action_kind text;
ALTER TABLE credit_transactions ADD COLUMN IF NOT EXISTS credit_rule_id uuid REFERENCES credit_rules(id);
DO $$ BEGIN
  ALTER TABLE credit_transactions
    ADD CONSTRAINT credit_action_kind_chk CHECK (action_kind IS NULL OR action_kind IN ('excel','chat','insight','report_generation'));
EXCEPTION WHEN duplicate_object THEN null;
END $$;

ALTER TABLE ai_usage_events ADD COLUMN IF NOT EXISTS billable_units integer;
