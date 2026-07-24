# macha-backend

CFO-layer SaaS backend for **Macha Finance** — Bun + Elysia + Drizzle ORM + PostgreSQL.
Multi-tenant with row-level isolation by `company_id`. See `CLAUDE.md` for the
non-negotiable rules and `../docs/data model.md` for the full schema rationale.

## Stack
Bun 1.x · Elysia · Drizzle ORM (+ drizzle-kit) · PostgreSQL (Railway) · pg-boss ·
Redis · AWS S3 · `jose` (JWT/JWKS) · Resend · Sentry · TypeScript strict.

## Getting started
```bash
bun install
cp .env.example .env      # fill in DATABASE_URL etc.
bun run db:generate       # drizzle-kit generates base-table migrations
bun run db:migrate        # applies raw SQL migrations (pgcrypto, RLS, checks, indexes)
bun run db:seed           # optional demo data (separate from schema migrations)
bun run dev
```

## Layout
```
src/
  db/
    schema/         # 27 Drizzle tables across domains (barrel: schema/index.ts)
    migrations/     # raw SQL: extensions, partitions+RLS, CHECKs, partial indexes
    client.ts       # postgres-js + drizzle
    migrate.ts      # applies raw SQL migrations in order
  guards/           # tenant.derive (auth + company_id), admin.guard (staff)
  lib/              # env, auth(JWKS), s3, anthropic(ZDR), resend
  queue/            # pg-boss + queue names
  modules/          # feature modules (routes + services); health/ scaffolded
scripts/
  provision_tenant.sql  # per-company PARTITION OF (run at onboarding)
  seed.ts
```

## F1 status
Foundations only: schema, migrations, tokens-agnostic scaffolding, guards as
placeholders (real WorkOS/tenant resolution + module logic land in F2+).
Not yet compiled against the npm/Bun registry in this environment.
