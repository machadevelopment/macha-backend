-- Hand-written (drizzle-kit cannot express PARTITION BY): creates transactions,
-- invoices, bills as the actual PARTITION BY LIST (company_id) parent tables
-- (CLAUDE.md non-negotiable rule), instead of the plain tables drizzle-kit would
-- generate for them in 0000_peaceful_mandroid.sql (excluded there on purpose — see
-- that file's header comment). Columns/PK/FKs/indexes below are copied verbatim
-- from src/db/schema/ledger.ts so Drizzle's runtime queries see an identical shape.
--
-- No partition covers any company_id yet — inserts fail until a per-tenant
-- partition exists (scripts/provision_tenant.sql, run at company onboarding, NOT
-- here). That's intentional, not a bug: a global migration can't know tenants in
-- advance.

CREATE TABLE IF NOT EXISTS "transactions" (
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"date" date NOT NULL,
	"type" text NOT NULL,
	"category" text NOT NULL,
	"description" text,
	"original_amount" numeric(18, 2) NOT NULL,
	"original_currency" text NOT NULL,
	"amount_base" numeric(18, 2) NOT NULL,
	"fx_rate" numeric(18, 8) NOT NULL,
	"fx_rate_date" date NOT NULL,
	"product_id" uuid,
	"store_id" uuid,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "transactions_company_id_id_pk" PRIMARY KEY("company_id","id")
) PARTITION BY LIST ("company_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "invoices" (
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"counterparty" text NOT NULL,
	"issue_date" date NOT NULL,
	"due_date" date,
	"original_amount" numeric(18, 2) NOT NULL,
	"original_currency" text NOT NULL,
	"amount_base" numeric(18, 2) NOT NULL,
	"fx_rate" numeric(18, 8) NOT NULL,
	"fx_rate_date" date NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"settled_transaction_id" uuid,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invoices_company_id_id_pk" PRIMARY KEY("company_id","id")
) PARTITION BY LIST ("company_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "bills" (
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"counterparty" text NOT NULL,
	"issue_date" date NOT NULL,
	"due_date" date,
	"original_amount" numeric(18, 2) NOT NULL,
	"original_currency" text NOT NULL,
	"amount_base" numeric(18, 2) NOT NULL,
	"fx_rate" numeric(18, 8) NOT NULL,
	"fx_rate_date" date NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"settled_transaction_id" uuid,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bills_company_id_id_pk" PRIMARY KEY("company_id","id")
) PARTITION BY LIST ("company_id");
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "transactions" ADD CONSTRAINT "transactions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "transactions" ADD CONSTRAINT "transactions_company_id_product_id_products_company_id_id_fk" FOREIGN KEY ("company_id","product_id") REFERENCES "public"."products"("company_id","id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "transactions" ADD CONSTRAINT "transactions_company_id_store_id_stores_company_id_id_fk" FOREIGN KEY ("company_id","store_id") REFERENCES "public"."stores"("company_id","id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "invoices" ADD CONSTRAINT "invoices_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "invoices" ADD CONSTRAINT "invoices_company_id_settled_transaction_id_transactions_company_id_id_fk" FOREIGN KEY ("company_id","settled_transaction_id") REFERENCES "public"."transactions"("company_id","id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "bills" ADD CONSTRAINT "bills_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "bills" ADD CONSTRAINT "bills_company_id_settled_transaction_id_transactions_company_id_id_fk" FOREIGN KEY ("company_id","settled_transaction_id") REFERENCES "public"."transactions"("company_id","id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "transactions_company_date_idx" ON "transactions" USING btree ("company_id","date");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "transactions_company_type_cat_date_idx" ON "transactions" USING btree ("company_id","type","category","date");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "transactions_company_document_idx" ON "transactions" USING btree ("company_id","document_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "invoices_company_status_due_idx" ON "invoices" USING btree ("company_id","status","due_date");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "invoices_company_document_idx" ON "invoices" USING btree ("company_id","document_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bills_company_status_due_idx" ON "bills" USING btree ("company_id","status","due_date");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bills_company_document_idx" ON "bills" USING btree ("company_id","document_id");
