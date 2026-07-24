-- Applied AFTER the drizzle-kit generated base tables.
-- drizzle-kit creates transactions/invoices/bills as plain tables; in production the
-- base tables must be declared PARTITION BY LIST (company_id). Because drizzle-kit does
-- not emit that, treat the generated tables as a template and (re)declare partitioning
-- here for a fresh DB. Per-tenant partitions are created at company provisioning, NOT here.
--
-- NOTE: on a brand-new database, prefer creating the three ledger tables directly as
-- partitioned (see scripts/provision_tenant.sql for the per-tenant PARTITION OF).

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
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY;', t);
    EXECUTE format($f$
      CREATE POLICY %I_tenant_isolation ON %I
      USING (company_id = current_setting('app.company_id', true)::uuid);
    $f$, t, t);
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
