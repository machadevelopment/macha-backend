-- Hardening found during a Calidad/QA backlog audit (ticket 868kfvay2/868kfvaz1):
-- verified against a real non-superuser Postgres role that OWNS the tables (exactly
-- the shape of a single Railway-provisioned DB user that both runs migrations and is
-- what DATABASE_URL points the app at) — and found two real gaps:
--
-- 1) `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` (0002/0009) does NOT apply to the
--    table owner by default. Since the app's own role owns every table (it ran the
--    migrations), the RLS backstop was a complete no-op for the app's own queries —
--    verified by inserting rows for two companies and reading them back cross-tenant
--    with app.company_id set to only one of them. `FORCE ROW LEVEL SECURITY` fixes
--    this (confirmed: closes the leak, doesn't break normal SET LOCAL app.company_id
--    flow) as long as the connecting role isn't a Postgres superuser — Railway's
--    managed Postgres does not grant superuser to the provisioned app role. This part
--    needs no elevated privilege beyond owning the table, so it always runs below.
--
-- 2) `REVOKE UPDATE, DELETE ... FROM PUBLIC` (0002/0009) does NOT restrict the table
--    owner either — Postgres owners always retain full implicit DML rights on their
--    own objects, unrevokable. Verified the same way: UPDATE/DELETE on ai_usage_events
--    succeeded despite the REVOKE, because the app's role owns that table. There is no
--    "FORCE" equivalent for privileges — the only real fix is a second, non-owning
--    role: `macha_app`.
--
-- Deploy note (Railway, manual, one-time): creating a role requires CREATEROLE, which
-- a managed-Postgres app user often does NOT have (and this migration deliberately
-- does not assume it has) — so `macha_app` is NOT created here. An operator must run,
-- once, directly against the real database:
--   CREATE ROLE macha_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS
--     PASSWORD '<generated>';
-- Then set APP_DATABASE_URL in Railway to a connection string using that role, and
-- either redeploy (this migration re-runs every deploy, see migrate.ts) or re-run
-- `bun run db:migrate` once — the GRANT/REVOKE block below only takes effect once
-- macha_app actually exists; until then it's a no-op (logged via NOTICE), and
-- APP_DATABASE_URL falls back to DATABASE_URL (env.ts) so nothing breaks meanwhile —
-- the append-only/RLS-for-the-app-role guarantees just aren't real yet.

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'transactions','invoices','bills','products','stores','fx_rates',
    'documents','staging_rows','metric_rollups','chats','chat_messages','chat_segments',
    'ai_usage_events','credit_transactions','insight_requests','reports','report_versions',
    'alert_rules','alert_events','notifications','company_users','subscriptions','payments'
  ] LOOP
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY;', t);
  END LOOP;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'macha_app') THEN
    RAISE NOTICE 'macha_app role does not exist yet — skipping GRANT/REVOKE block. See migration header for the manual CREATE ROLE step.';
    RETURN;
  END IF;

  EXECUTE format('GRANT CONNECT ON DATABASE %I TO macha_app', current_database());

  -- USAGE+CREATE (not just USAGE): provisionTenantPartitions() runs CREATE TABLE ...
  -- PARTITION OF at company onboarding time via the app's own runtime connection
  -- (both the admin manual-create flow and the M8 self-serve register flow), not
  -- only from an offline script — the restricted role needs CREATE on the schema.
  GRANT USAGE, CREATE ON SCHEMA public TO macha_app;
  EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO macha_app';
  EXECUTE 'GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO macha_app';

  -- Covers tables added by future migrations (run by the owner role) automatically —
  -- does NOT cover partitions macha_app creates itself at runtime (it owns those
  -- directly, no grant needed) — those get FORCE ROW LEVEL SECURITY applied
  -- explicitly by provisionTenantPartitions() right after creation instead
  -- (lib/tenant-provisioning.ts).
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO macha_app;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO macha_app;

  EXECUTE 'REVOKE UPDATE, DELETE ON ai_usage_events FROM macha_app';
  EXECUTE 'REVOKE UPDATE, DELETE ON credit_transactions FROM macha_app';
  EXECUTE 'REVOKE UPDATE, DELETE ON admin_audit_log FROM macha_app';
  EXECUTE 'REVOKE UPDATE, DELETE ON report_versions FROM macha_app';
  EXECUTE 'REVOKE UPDATE, DELETE ON industry_template_versions FROM macha_app';
  EXECUTE 'REVOKE UPDATE, DELETE ON payments FROM macha_app';
END $$;
