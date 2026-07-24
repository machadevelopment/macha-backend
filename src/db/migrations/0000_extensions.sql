-- Raw SQL migration (hand-written). Runs before drizzle-kit generated schema.
CREATE EXTENSION IF NOT EXISTS pgcrypto;  -- gen_random_uuid()
