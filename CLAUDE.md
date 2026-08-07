# CLAUDE.md — Macha Finance

CFO-layer SaaS for SMEs. Multi-tenant, **sensitive financial data**. Two separate repos (not a monorepo): `macha-frontend` (Vercel) and `macha-backend` (Railway). This file documents constraints that are **not inferable from the code**. Keep both repos' copies in sync when a shared rule changes.

## Non-negotiable rules (always)
- **Tenant isolation**: every business query is scoped by `company_id`. `company_id` is resolved server-side from the verified JWT — **never** from the client or an AI model. No query touches a business table without it. The RLS backstop only works if the app connects as `macha_app` (migration `0010_force_rls_and_app_role.sql`), a role that never owns the tables — the owner role (used by migrations) silently bypasses `ENABLE ROW LEVEL SECURITY` entirely (verified against a real instance); `FORCE ROW LEVEL SECURITY` fixes that for the owner too, but only a non-superuser connection.
- **Runtime is Bun, not Node.** Before adding any dependency/SDK, verify Bun compatibility. Do not add Node-only libs.
- **ORM is Drizzle, not Prisma.** Never introduce Prisma.
- **No passwords/secrets in the DB.** Identity is WorkOS/AuthKit; there is no password/hash column anywhere.
- **AI provider is Anthropic Claude only, under a signed ZDR contract.** No OpenAI/other vendors. Never persist prompts or customer financial data in the provider. Re-verify ZDR eligibility on any model change. Initial model: `claude-sonnet-5`.
- **Append-only ledgers** (`ai_usage_events`, `credit_transactions`, `admin_audit_log`, `report_versions`, `industry_template_versions`, `payments`, `inventory_movements`): insert only, never UPDATE/DELETE. Corrections are compensating rows. This is only a real DB-level guarantee if the app connects as `macha_app`, not the owner role — Postgres table owners always retain implicit UPDATE/DELETE regardless of `REVOKE ... FROM PUBLIC` (verified; there is no "FORCE" for privileges the way there is for RLS).
- **Money is `numeric`, never float.** Store original amount+currency AND converted `amount_base`; FX rate is snapshotted per row.
- Secrets are platform-native (Vercel/Railway env). **Non-prod credentials are fully separate** (WorkOS, Anthropic, S3, Redis). Never point staging/preview at prod services.

## Backend — `macha-backend` (Bun + Elysia)
Stack: Bun 1.x · Elysia · Drizzle ORM + `drizzle-kit` · PostgreSQL (Railway, managed) · pg-boss (jobs, Postgres-backed) · Redis (Railway, rate limiting) · AWS S3 · `jose` (JWT/JWKS) · Resend · Sentry (`@sentry/bun`) · TypeScript strict.

Commands (Bun as package manager + runner):
```
bun install
bun run dev            # Elysia dev server (watch)
bun run build          # production build
bun run typecheck      # tsc --noEmit
bun run lint           # eslint
bun test               # tests unitarios (solo src/, no tocan Postgres)
bun run test:db:up     # Postgres efímero para integración (docker compose)
bun run test:integration  # migraciones + rol macha_app + tests de RLS/append-only/guards
bun run test:db:down   # baja el Postgres de test y borra su volumen
bun run db:generate    # drizzle-kit generate (schema migrations)
bun run db:migrate     # apply migrations
bun run db:seed        # data/seed scripts (manual, separate from schema migrations)
```

Conventions & gotchas:
- **Guards/`derive` are the enforcement point.** Auth + tenant-scoping live in Elysia `derive`/`guard`; `derive` injects `{ userId, companyId, role }`. Handlers assume these are present and validated.
- **Admin is a separate namespace.** `/admin/*` is structurally separated from the tenant-scoped guard chain and gated by the `staff` table (`staff`/`super_admin`). Every admin mutation writes `admin_audit_log`.
- **Validation uses Elysia's TypeBox schemas**, not zod-by-default.
- **Partitioned tables**: `transactions`, `invoices`, `bills` are `PARTITION BY LIST (company_id)`. PK is composite `(company_id, id)`. `drizzle-kit` does **not** generate `CREATE ... PARTITION OF` — write that + RLS + partial/expression indexes + `REVOKE UPDATE,DELETE` as **raw SQL** inside migrations. Tenant partitions are created at company provisioning, not in a global migration.
- **Cross-tenant FKs are composite** (include `company_id`) to make cross-tenant references impossible.
- **Dos GUC por request, no uno** (CU-868kj3utc, migración `0012`): `app.user_id` se setea con `SET LOCAL` en cuanto se verifica el JWT, y `app.company_id` solo después de resolver la membresía — ambos sobre **la misma conexión reservada**. La política de `company_users` permite leer por empresa **o por usuario**, porque es la tabla donde se descubre la empresa y no se puede filtrar por algo que aún no se conoce. Un `SECURITY DEFINER` no sirve aquí: `FORCE ROW LEVEL SECURITY` (0010) también sujeta al dueño. Y toda política usa `nullif(current_setting(...), '')`: un GUC revertido al cerrar la transacción vale cadena vacía, no NULL, y `''::uuid` lanza error en la siguiente request de esa conexión.
- **Two DB roles, not one**: `DATABASE_URL` (owner, runs migrations/seed/provision CLI) vs `APP_DATABASE_URL` (restricted `macha_app`, what the running app actually connects as — `src/db/client.ts`). Falls back to `DATABASE_URL` if `APP_DATABASE_URL` is unset, but the RLS/append-only guarantees are then no-ops for the app's own queries (owner bypasses both). `macha_app`'s password isn't in any migration/env file — an operator sets it once directly against Railway's Postgres, then sets `APP_DATABASE_URL`.
- **Schema migrations auto-apply on deploy** (gated by manual promote to prod). Data/seed migrations run as separate manual scripts — never mix them.
- **Excel ingestion is async via pg-boss.** One Claude call per sheet; rows land in a single staging table.
  **Promotion is PARTIAL (Keneth's call, 2026-08-07 — migration `0020`)**: clean rows promote on their own, only
  flagged rows are held back for internal review, and each one promotes incrementally as staff resolves it. A
  `promoted` document with `flagged_count > 0` is the normal state, not a contradiction. The SQL atomicity still
  holds (one tx, all-or-nothing) but over the *promotable* rows, not the whole document — the previous rule
  ("no row promotes while any flagged row is unresolved") turned internal review, meant to be the exception, into
  the mandatory path for every upload: 0 rows in production against 3,195 in staging, measured 2026-08-06.
  Idempotency is therefore **per row** (`staging_rows.promoted_at`), not per document — the old document-level
  lock blocked the legitimate second pass. Revert = soft-delete by `document_id`.
- **Rate limiting**: per-company token-bucket in Redis + queue-depth gate reading pg-boss's own tables. No custom rate-limit table.
- **Every Claude call inserts one `ai_usage_events` row** tagged `kind` (`excel`/`chat`/`insight`/`report_generation`/`excel_correction`). `insight` debits credits; `excel_correction` never does.
- **S3 stores binaries; DB stores only keys** (`documents.s3_key`, `report_versions.s3_render_key`). Access via short-lived presigned URLs after tenant/role check. Prefix keys by `company_id`.
- Chat: `company_id` injected server-side; tool-use (no RAG, no vector DB).

Rough layout: `src/modules/<module>/` (routes+services), `src/db/schema/` (Drizzle tables), `src/db/migrations/` (drizzle-kit + raw SQL), `src/queue/` (pg-boss + thin queue interface), `src/lib/` (auth/jwks, s3, resend, anthropic), `src/guards/`.

## Frontend — `macha-frontend` (Next.js)
Stack: Next.js (App Router) · React 18 · TypeScript strict · Tailwind CSS · shadcn/ui (Radix) · Tremor Raw (charts/KPIs, on Recharts) · Lucide React · `next-themes` · i18n ES/EN · `next/font` (Inter + JetBrains Mono).

Commands:
```
bun install
bun run dev            # next dev
bun run build          # next build
bun run start          # next start
bun run typecheck      # tsc --noEmit
bun run lint           # next lint
bun test               # bun test
```

Conventions & gotchas:
- **Admin panel lives here**, not in a third app: `/admin/*` routes, role-gated (reads `staff` tier via backend).
- **El panel admin es bilingüe ES/EN** (CU-868kh8zvt, decisión de Jose 2026-07-28). La razón **no es operativa** — el equipo de Macha trabaja en español — sino de negocio: el backoffice es donde se demuestra la maquinaria del producto ante inversionistas de habla inglesa en una ronda, y mostrarlo a medias resta en el peor momento posible. **Toda pantalla nueva de `/admin/*` nace con sus textos en el diccionario**, nunca quemados: agregarlos a medida que se construye es casi gratis, y retrofitear el panel entero después no lo es (fue exactamente este ticket).
- **Design tokens are the source of truth** (see `design guide.md`): two-layer CSS variables with **full light + dark** themes; never hardcode hex. `darkMode: 'class'`.
- **Two densities**: `data-density="compact"` (dashboards/tables) vs `"comfortable"` (forms/onboarding). Paddings read from density tokens.
- **Mono rule**: all numbers, amounts, %, deltas, IDs, timestamps, and uppercase eyebrows/labels use `JetBrains Mono` (`font-mono`, `tabular-nums`); everything else uses `Inter` (`font-ui`).
- **Color only signals state/financial semantics** (green/red delta, chips, meters), never decoration, and always as text+bg+border together.
- **Formatting is locale-aware and centralized**: use `formatMoney/formatDate/formatPct` helpers over `Intl.*` (`es-GT`/`en-US`); always show explicit currency code (GTQ/USD). Never format inline.
- **Component split**: Tremor Raw for charts + KPI/indicator cards; shadcn/ui for everything else. Don't use two libs for the same role. **Known deviation**: F1 actually installed `@tremor/react` (the classic npm package), not real Tremor Raw (copy-paste source) — decided 2026-07-27 to avoid a mid-epic chart-library migration; restyled on our own tokens. Revisit only if `@tremor/react` becomes a real blocker.
- Auth UI is WorkOS AuthKit (hosted); the app verifies session, it does not implement login/password/email-verification.
- Do **not** use `localStorage`/`sessionStorage` in artifacts/prototypes; use React state.

Rough layout: `app/(app)/` (customer), `app/admin/` (backoffice), `components/ui/` (shadcn), `components/charts/` (Tremor), `lib/format/`, `lib/i18n/`, `styles/globals.css` (tokens).

## Environments
Production + persistent staging (synthetic data only) + ephemeral per-PR previews. **`dev` is the integration branch: `feat/*` branches off `dev` and merges back into `dev`** (agent-merged once checks pass, no per-ticket human review). `main` is the trunk that Railway/Vercel deploy to STAGING; it only receives merges from `dev` per completed epic, reviewed (by another AI or Semi if requested) and merged by the owner — never by the agent. Prod requires manual promote. CI gate: lint + test (GitHub Actions) + local pre-push hook. Backups: Railway native + nightly `pg_dump` to S3 (30-day rolling). See `flux.md` for the full process.

## Docs (planning source of truth, in this workspace)
`PRD.md` · `data model.md` · `design guide.md` · `flux.md` (proceso/ramas). Read the relevant one before changing behavior in that area.

> **Nota (auditoría 2026-07-28):** versiones anteriores de este archivo y de `flux.md` §10 listaban también `docs/map.md`, `docs/architecture-report.md` y `docs/issues/*` como contexto obligatorio. **Ese directorio `docs/` nunca existió en el workspace** — las decisiones de arquitectura viven en `PRD.md` §5 y en los comentarios de cabecera del propio código (que documentan el "por qué" verificado contra instancias reales, p. ej. `src/db/migrations/0010_force_rls_and_app_role.sql`). Referencias eliminadas para no mandar a leer archivos inexistentes.
