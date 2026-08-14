-- Applied AFTER 0000_peaceful_mandroid.sql (drizzle-kit generated base tables) and
-- 0001_partitioned_ledger_tables.sql (hand-written transactions/invoices/bills as
-- PARTITION BY LIST (company_id) parents — drizzle-kit can't emit that, so those
-- three are excluded from 0000 and created there instead). RLS below applies to
-- both: policies on a partitioned parent propagate to every partition, so it works
-- the same whether a table is plain or partitioned. Per-tenant partitions are
-- created at company provisioning (scripts/provision_tenant.sql), NOT here.

-- ---- Row-Level Security backstop (scoping is primarily enforced in Elysia guards) ----
-- Enable RLS and add a company_id policy driven by a per-request GUC (app.company_id).
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'transactions','invoices','bills','products','stores','fx_rates',
    'documents','staging_rows','metric_rollups','chats','chat_messages','chat_segments',
    'ai_usage_events','credit_transactions','insight_requests','reports','report_versions',
    'alert_rules','alert_events','notifications','company_users'
  ] LOOP
    PERFORM macha_asegurar_rls(t);
    -- CREATE POLICY has no IF NOT EXISTS — re-running this file (migrate.ts applies
    -- every .sql file on every invocation, see its header comment) would otherwise
    -- fail the second time with "policy already exists".
    BEGIN
      EXECUTE format($f$
        CREATE POLICY %I_tenant_isolation ON %I
        USING (company_id = current_setting('app.company_id', true)::uuid);
      $f$, t, t);
    EXCEPTION WHEN duplicate_object THEN NULL;
    END;
  END LOOP;
END $$;

-- ---- Append-only ledgers: block UPDATE/DELETE at the privilege layer ----
-- Corrections are compensating rows. (Grant only what the app role needs.)
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'ai_usage_events','credit_transactions','admin_audit_log',
    'report_versions','industry_template_versions'
  ] LOOP
    EXECUTE format('REVOKE UPDATE, DELETE ON %I FROM PUBLIC;', t);
  END LOOP;
END $$;
