-- Per-tenant provisioning: create the LIST partitions for a company.
-- Run at company onboarding (NOT a global migration). :cid is the company_id uuid.
CREATE TABLE IF NOT EXISTS transactions_:cid PARTITION OF transactions FOR VALUES IN (':cid');
CREATE TABLE IF NOT EXISTS invoices_:cid     PARTITION OF invoices     FOR VALUES IN (':cid');
CREATE TABLE IF NOT EXISTS bills_:cid        PARTITION OF bills        FOR VALUES IN (':cid');
