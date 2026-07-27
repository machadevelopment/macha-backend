-- drizzle-kit generated (bun node_modules/drizzle-kit/bin.cjs generate), renumbered
-- into this repo's actual migration sequence (drizzle's own journal only tracks its
-- prior 0000_peaceful_mandroid.sql, so it numbered this "0001" — see PR #27 for why).
CREATE TABLE IF NOT EXISTS "platform_settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
