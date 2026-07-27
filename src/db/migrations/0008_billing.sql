-- drizzle-kit generated (bun node_modules/drizzle-kit/bin.cjs generate), renumbered
-- into this repo's sequence — see PR #27 for why `node` directly hits an esbuild
-- mismatch here. RLS + append-only REVOKE for these two tables live in
-- 0009_billing_rls.sql (can't edit the already-shipped 0002_partitions_rls.sql).
CREATE TABLE IF NOT EXISTS "payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"subscription_id" uuid,
	"kind" text NOT NULL,
	"provider_event_id" text NOT NULL,
	"provider_payment_id" text,
	"status" text NOT NULL,
	"amount_usd_cents" integer NOT NULL,
	"credits_granted" integer,
	"failure_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"provider_name" text DEFAULT 'recurrente' NOT NULL,
	"provider_subscription_id" text,
	"provider_checkout_id" text,
	"plan_code" text DEFAULT 'base' NOT NULL,
	"amount_usd_cents" integer NOT NULL,
	"status" text DEFAULT 'pending_checkout' NOT NULL,
	"current_period_start" timestamp with time zone,
	"current_period_end" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "payments" ADD CONSTRAINT "payments_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "payments_company_created_idx" ON "payments" USING btree ("company_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "payments_provider_event_uq" ON "payments" USING btree ("provider_event_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "subscriptions_company_idx" ON "subscriptions" USING btree ("company_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "subscriptions_provider_sub_uq" ON "subscriptions" USING btree ("provider_subscription_id");