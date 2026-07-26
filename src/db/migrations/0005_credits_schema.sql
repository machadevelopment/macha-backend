-- CU-868kfv97x: motor de reglas de créditos versionado (Jose: la forma del consumo se
-- decide ahora, los números no). drizzle-kit no pudo correr en este entorno (mismatch
-- de arquitectura de esbuild, sin Postgres local disponible) — igual que
-- 0004_alert_notify_immediately.sql, tabla/columnas agregadas a mano.

CREATE TABLE IF NOT EXISTS credit_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  action_kind text NOT NULL,
  rule_type text NOT NULL,
  credits_per_unit numeric(10,4) NOT NULL,
  unit text, -- null cuando rule_type='fixed'
  version integer NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT credit_rules_action_version_uq UNIQUE (action_kind, version),
  CONSTRAINT credit_rules_action_chk CHECK (action_kind IN ('excel','chat','insight','report_generation')),
  CONSTRAINT credit_rules_type_chk   CHECK (rule_type IN ('fixed','variable')),
  CONSTRAINT credit_rules_unit_chk   CHECK (unit IS NULL OR unit IN ('execution','batch','sheet','row')),
  CONSTRAINT credit_rules_credits_chk CHECK (credits_per_unit > 0)
);

ALTER TABLE credit_transactions ADD COLUMN IF NOT EXISTS action_kind text;
ALTER TABLE credit_transactions ADD COLUMN IF NOT EXISTS credit_rule_id uuid REFERENCES credit_rules(id);
ALTER TABLE credit_transactions
  ADD CONSTRAINT credit_action_kind_chk CHECK (action_kind IS NULL OR action_kind IN ('excel','chat','insight','report_generation'));

ALTER TABLE ai_usage_events ADD COLUMN IF NOT EXISTS billable_units integer;
