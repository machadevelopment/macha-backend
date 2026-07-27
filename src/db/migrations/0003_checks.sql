-- All CHECK constraints from data model.md §7 (enums-as-text + money/rate rules).
-- Each wrapped in DO $$ ... EXCEPTION WHEN duplicate_object — plain ALTER TABLE ADD
-- CONSTRAINT has no IF NOT EXISTS, and migrate.ts re-applies every .sql file on every
-- invocation (see its header comment), so this file must tolerate re-runs.

DO $$ BEGIN ALTER TABLE companies ADD CONSTRAINT companies_base_currency_chk CHECK (base_currency IN ('GTQ','USD')); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE companies ADD CONSTRAINT companies_status_chk CHECK (status IN ('active','suspended')); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE companies ADD CONSTRAINT companies_locale_chk CHECK (locale IN ('es','en')); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN ALTER TABLE company_users ADD CONSTRAINT company_users_role_chk CHECK (role IN ('owner','admin','member')); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE company_users ADD CONSTRAINT company_users_status_chk CHECK (status IN ('active','invited','revoked')); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN ALTER TABLE staff ADD CONSTRAINT staff_tier_chk CHECK (tier IN ('staff','super_admin')); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE staff ADD CONSTRAINT staff_status_chk CHECK (status IN ('active','disabled')); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN ALTER TABLE transactions ADD CONSTRAINT transactions_type_chk CHECK (type IN ('revenue','cogs','opex','other')); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE transactions ADD CONSTRAINT transactions_currency_chk CHECK (original_currency IN ('GTQ','USD')); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN ALTER TABLE invoices ADD CONSTRAINT invoices_status_chk CHECK (status IN ('open','paid')); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE invoices ADD CONSTRAINT invoices_currency_chk CHECK (original_currency IN ('GTQ','USD')); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE bills ADD CONSTRAINT bills_status_chk CHECK (status IN ('open','paid')); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE bills ADD CONSTRAINT bills_currency_chk CHECK (original_currency IN ('GTQ','USD')); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN ALTER TABLE fx_rates ADD CONSTRAINT fx_rates_base_chk CHECK (base_currency IN ('GTQ','USD')); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE fx_rates ADD CONSTRAINT fx_rates_quote_chk CHECK (quote_currency IN ('GTQ','USD')); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE fx_rates ADD CONSTRAINT fx_rates_rate_chk CHECK (rate > 0); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN ALTER TABLE documents ADD CONSTRAINT documents_status_chk CHECK (status IN ('queued','processing','review','promoted','reverted','failed')); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE staging_rows ADD CONSTRAINT staging_rows_target_chk CHECK (target_entity IN ('transaction','invoice','bill')); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE staging_rows ADD CONSTRAINT staging_rows_review_chk CHECK (review_status IN ('pending','clean','approved','rejected')); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN ALTER TABLE metric_rollups ADD CONSTRAINT metric_rollups_gran_chk CHECK (granularity IN ('month','quarter','year')); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN ALTER TABLE chat_messages ADD CONSTRAINT chat_messages_role_chk CHECK (role IN ('user','assistant','tool')); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN ALTER TABLE ai_usage_events ADD CONSTRAINT ai_usage_kind_chk CHECK (kind IN ('excel','chat','insight','report_generation','excel_correction')); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- CU-868kfv97x: reason se generaliza (era 'insight_consumption' fijo). El CHECK sobre
-- action_kind (columna nueva) y la tabla credit_rules van en 0006_credits_schema.sql,
-- junto con su creación, para no referenciar una tabla/columna que aun no existe en
-- este punto del orden de migraciones.
DO $$ BEGIN ALTER TABLE credit_transactions ADD CONSTRAINT credit_reason_chk CHECK (reason IN ('monthly_allotment','top_up','consumption')); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN ALTER TABLE reports ADD CONSTRAINT reports_frequency_chk CHECK (frequency IN ('daily','weekly')); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN ALTER TABLE notifications ADD CONSTRAINT notifications_kind_chk CHECK (kind IN ('report','alert')); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE notifications ADD CONSTRAINT notifications_status_chk CHECK (status IN ('queued','sent','delivered','bounced','failed')); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
