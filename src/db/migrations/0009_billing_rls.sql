-- CU-868kfvae6/868kfvaed: RLS backstop for subscriptions/payments (added after
-- 0002_partitions_rls.sql shipped, so extending here rather than editing that file)
-- + append-only REVOKE for payments (a payment is a fact, corrections are
-- compensating rows — same rule as credit_transactions/ai_usage_events).
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['subscriptions', 'payments'] LOOP
    PERFORM macha_asegurar_rls(t);
    BEGIN
      EXECUTE format($f$
        CREATE POLICY %I_tenant_isolation ON %I
        USING (company_id = current_setting('app.company_id', true)::uuid);
      $f$, t, t);
    EXCEPTION WHEN duplicate_object THEN NULL;
    END;
  END LOOP;
END $$;

REVOKE UPDATE, DELETE ON payments FROM PUBLIC;
