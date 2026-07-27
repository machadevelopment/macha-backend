-- Partial / expression indexes that drizzle-kit does not express (data model.md §6, §20).

-- Case-insensitive uniqueness
CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_uq       ON users (lower(email));
CREATE UNIQUE INDEX IF NOT EXISTS companies_name_lower_uq    ON companies (lower(name));
CREATE UNIQUE INDEX IF NOT EXISTS products_company_name_uq   ON products (company_id, lower(name));
CREATE UNIQUE INDEX IF NOT EXISTS stores_company_name_uq     ON stores (company_id, lower(name));

-- Analytics indexes limited to live rows (exclude soft-deleted)
CREATE INDEX IF NOT EXISTS transactions_live_date_idx
  ON transactions (company_id, date) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS invoices_live_status_due_idx
  ON invoices (company_id, status, due_date) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS bills_live_status_due_idx
  ON bills (company_id, status, due_date) WHERE deleted_at IS NULL;

-- Only flagged staging rows need review
CREATE INDEX IF NOT EXISTS staging_rows_flagged_idx
  ON staging_rows (company_id, document_id) WHERE flag_reason IS NOT NULL;
