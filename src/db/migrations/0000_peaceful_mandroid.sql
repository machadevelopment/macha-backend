-- drizzle-kit generated (bun node_modules/drizzle-kit/bin.cjs generate — running
-- through `node` directly hits an esbuild darwin-x64/arm64 mismatch in this sandbox,
-- see PR description). transactions/invoices/bills are deliberately EXCLUDED here:
-- drizzle-kit can't express PARTITION BY, so those three are hand-written instead in
-- 0001_partitioned_ledger_tables.sql (CLAUDE.md non-negotiable: they must be
-- PARTITION BY LIST (company_id), not plain tables).
CREATE TABLE IF NOT EXISTS "admin_audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_staff_id" uuid NOT NULL,
	"company_id" uuid,
	"action" text NOT NULL,
	"target_table" text,
	"target_id" uuid,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ai_usage_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"ref_id" uuid,
	"model" text NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cost_usd" numeric(12, 6) NOT NULL,
	"billable_units" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "alert_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"alert_rule_id" uuid NOT NULL,
	"triggered_value" numeric(18, 4) NOT NULL,
	"document_id" uuid,
	"notification_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "alert_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"rule_key" text NOT NULL,
	"threshold" numeric(18, 4) NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"notify_immediately" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "chat_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"chat_id" uuid NOT NULL,
	"segment_id" uuid,
	"role" text NOT NULL,
	"content" text NOT NULL,
	"ai_usage_event_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "chat_segments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"chat_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"handoff_doc" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "chats" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"title" text DEFAULT 'Nuevo chat' NOT NULL,
	"report_version_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "companies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workos_org_id" text NOT NULL,
	"name" text NOT NULL,
	"industry" text NOT NULL,
	"base_currency" text DEFAULT 'GTQ' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"locale" text DEFAULT 'es' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "company_users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"receives_reports" boolean DEFAULT true NOT NULL,
	"invited_by" uuid,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "credit_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"action_kind" text NOT NULL,
	"rule_type" text NOT NULL,
	"credits_per_unit" numeric(10, 4) NOT NULL,
	"unit" text,
	"version" integer NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "credit_transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"delta" integer NOT NULL,
	"reason" text NOT NULL,
	"action_kind" text,
	"credit_rule_id" uuid,
	"ref_id" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"uploaded_by" uuid NOT NULL,
	"s3_key" text NOT NULL,
	"original_filename" text NOT NULL,
	"file_size_bytes" bigint NOT NULL,
	"mime_type" text NOT NULL,
	"industry_template_version_id" uuid,
	"status" text DEFAULT 'queued' NOT NULL,
	"row_count" integer,
	"flagged_count" integer,
	"error_reason" text,
	"promoted_at" timestamp with time zone,
	"reverted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "fx_rates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"base_currency" text NOT NULL,
	"quote_currency" text NOT NULL,
	"rate" numeric(18, 8) NOT NULL,
	"effective_date" date NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "industry_template_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"template_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"synonyms" jsonb NOT NULL,
	"few_shot" jsonb NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "industry_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"industry" text NOT NULL,
	"name" text NOT NULL,
	"current_version_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "insight_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"requested_by" uuid NOT NULL,
	"prompt_snapshot" text NOT NULL,
	"result" text,
	"ai_usage_event_id" uuid,
	"credit_transaction_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "metric_rollups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"granularity" text NOT NULL,
	"period" date NOT NULL,
	"type" text,
	"category" text,
	"amount_base" numeric(18, 2) NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"recipient_email" text NOT NULL,
	"ref_id" uuid,
	"resend_message_id" text,
	"status" text DEFAULT 'queued' NOT NULL,
	"error_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "products" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text NOT NULL,
	"external_ref" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "report_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"report_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"metrics" jsonb NOT NULL,
	"narrative" text NOT NULL,
	"s3_render_key" text,
	"ai_usage_event_id" uuid,
	"edited_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"period_start" date NOT NULL,
	"period_end" date NOT NULL,
	"frequency" text NOT NULL,
	"current_version_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "staff" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"tier" text DEFAULT 'staff' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "staging_rows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"target_entity" text NOT NULL,
	"payload" jsonb NOT NULL,
	"confidence" numeric(5, 4),
	"flag_reason" text,
	"review_status" text DEFAULT 'pending' NOT NULL,
	"reviewed_by" uuid,
	"reviewed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "stores" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text NOT NULL,
	"external_ref" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workos_user_id" text NOT NULL,
	"email" text NOT NULL,
	"name" text,
	"locale" text DEFAULT 'es' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "admin_audit_log" ADD CONSTRAINT "admin_audit_log_actor_staff_id_staff_id_fk" FOREIGN KEY ("actor_staff_id") REFERENCES "public"."staff"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ai_usage_events" ADD CONSTRAINT "ai_usage_events_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "alert_events" ADD CONSTRAINT "alert_events_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "alert_events" ADD CONSTRAINT "alert_events_alert_rule_id_alert_rules_id_fk" FOREIGN KEY ("alert_rule_id") REFERENCES "public"."alert_rules"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "alert_rules" ADD CONSTRAINT "alert_rules_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_chat_id_chats_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."chats"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "chat_segments" ADD CONSTRAINT "chat_segments_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "chat_segments" ADD CONSTRAINT "chat_segments_chat_id_chats_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."chats"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "chats" ADD CONSTRAINT "chats_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "chats" ADD CONSTRAINT "chats_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "company_users" ADD CONSTRAINT "company_users_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "company_users" ADD CONSTRAINT "company_users_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "credit_transactions" ADD CONSTRAINT "credit_transactions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "credit_transactions" ADD CONSTRAINT "credit_transactions_credit_rule_id_credit_rules_id_fk" FOREIGN KEY ("credit_rule_id") REFERENCES "public"."credit_rules"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "documents" ADD CONSTRAINT "documents_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "documents" ADD CONSTRAINT "documents_industry_template_version_id_industry_template_versions_id_fk" FOREIGN KEY ("industry_template_version_id") REFERENCES "public"."industry_template_versions"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "fx_rates" ADD CONSTRAINT "fx_rates_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "industry_template_versions" ADD CONSTRAINT "industry_template_versions_template_id_industry_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."industry_templates"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "insight_requests" ADD CONSTRAINT "insight_requests_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "insight_requests" ADD CONSTRAINT "insight_requests_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "metric_rollups" ADD CONSTRAINT "metric_rollups_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "notifications" ADD CONSTRAINT "notifications_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "products" ADD CONSTRAINT "products_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "report_versions" ADD CONSTRAINT "report_versions_report_id_reports_id_fk" FOREIGN KEY ("report_id") REFERENCES "public"."reports"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "reports" ADD CONSTRAINT "reports_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "staff" ADD CONSTRAINT "staff_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "staging_rows" ADD CONSTRAINT "staging_rows_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "staging_rows" ADD CONSTRAINT "staging_rows_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "stores" ADD CONSTRAINT "stores_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "admin_audit_log_company_created_idx" ON "admin_audit_log" USING btree ("company_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "admin_audit_log_actor_created_idx" ON "admin_audit_log" USING btree ("actor_staff_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "admin_audit_log_action_idx" ON "admin_audit_log" USING btree ("action");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ai_usage_events_company_created_idx" ON "ai_usage_events" USING btree ("company_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ai_usage_events_company_kind_created_idx" ON "ai_usage_events" USING btree ("company_id","kind","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "alert_events_company_created_idx" ON "alert_events" USING btree ("company_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "alert_events_company_rule_idx" ON "alert_events" USING btree ("company_id","alert_rule_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "alert_rules_uq" ON "alert_rules" USING btree ("company_id","rule_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "alert_rules_company_enabled_idx" ON "alert_rules" USING btree ("company_id","enabled");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "chat_messages_company_chat_created_idx" ON "chat_messages" USING btree ("company_id","chat_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "chat_segments_uq" ON "chat_segments" USING btree ("company_id","chat_id","seq");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "chats_company_user_updated_idx" ON "chats" USING btree ("company_id","user_id","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "companies_workos_org_uq" ON "companies" USING btree ("workos_org_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "company_users_company_user_uq" ON "company_users" USING btree ("company_id","user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "company_users_company_role_idx" ON "company_users" USING btree ("company_id","role");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "company_users_user_idx" ON "company_users" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "credit_rules_action_version_uq" ON "credit_rules" USING btree ("action_kind","version");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "credit_transactions_company_created_idx" ON "credit_transactions" USING btree ("company_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "documents_company_status_idx" ON "documents" USING btree ("company_id","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "documents_company_created_idx" ON "documents" USING btree ("company_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "fx_rates_uq" ON "fx_rates" USING btree ("company_id","base_currency","quote_currency","effective_date");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fx_rates_lookup_idx" ON "fx_rates" USING btree ("company_id","quote_currency","effective_date");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "industry_template_versions_uq" ON "industry_template_versions" USING btree ("template_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "industry_templates_industry_uq" ON "industry_templates" USING btree ("industry");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "insight_requests_company_created_idx" ON "insight_requests" USING btree ("company_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "metric_rollups_uq" ON "metric_rollups" USING btree ("company_id","granularity","period","type","category");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "metric_rollups_company_period_idx" ON "metric_rollups" USING btree ("company_id","granularity","period");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "notifications_company_created_idx" ON "notifications" USING btree ("company_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "notifications_resend_idx" ON "notifications" USING btree ("resend_message_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "products_company_idx" ON "products" USING btree ("company_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "products_company_id_uq" ON "products" USING btree ("company_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "report_versions_uq" ON "report_versions" USING btree ("report_id","version");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "report_versions_company_report_idx" ON "report_versions" USING btree ("company_id","report_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "reports_company_period_idx" ON "reports" USING btree ("company_id","period_end");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "staff_user_uq" ON "staff" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "staff_tier_idx" ON "staff" USING btree ("tier");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "staging_rows_company_document_idx" ON "staging_rows" USING btree ("company_id","document_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "staging_rows_company_review_idx" ON "staging_rows" USING btree ("company_id","review_status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "stores_company_idx" ON "stores" USING btree ("company_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "stores_company_id_uq" ON "stores" USING btree ("company_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "users_workos_user_uq" ON "users" USING btree ("workos_user_id");