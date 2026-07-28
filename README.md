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

## Environment variables

Secrets live only in platform-native envs (Railway) or a local untracked `.env` —
never committed (`.gitignore` blocks `.env*` except `.env.example`). **Non-prod
credentials are fully separate values from prod** for every external service below;
staging/preview never point at prod WorkOS, Anthropic, S3, Redis, Resend, or
Recurrente, so an incident in staging can't touch prod auth, AI spend, storage,
rate limits, or billing. See `.env.example` for the full annotated list; summary:

| Variable | Required | Notes |
|---|---|---|
| `DATABASE_URL` | Yes | Owner role — migrations/seed/provisioning only. Never used by the running app in a real env. |
| `APP_DATABASE_URL` | Prod/staging | Restricted `macha_app` role the app actually connects as. Falls back to `DATABASE_URL` if unset (RLS/append-only become no-ops without it). |
| `REDIS_URL` | Yes | Rate limiting (Railway plugin). |
| `INTAKE_*` | No (has defaults) | Excel intake caps, CU-868kfv972. |
| `RATE_LIMIT_*` | No (has defaults) | Token-bucket + queue-depth gate values. |
| `CREDIT_*` | No (has defaults) | Credit ratio/allotment, provisional startup values. |
| `WORKOS_JWKS_URL`, `WORKOS_CLIENT_ID` | Yes | JWT verification (JWKS), no password/session logic here. |
| `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL` | Yes | ZDR contract only; model kept in config, never hardcoded. |
| `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | Yes | Binaries only; DB stores keys, not files. |
| `RESEND_API_KEY`, `RESEND_FROM_EMAIL` | Yes | Transactional email. |
| `SENTRY_DSN` | Prod/staging | No-op without it (local/dev/CI never set it). |
| `APP_BASE_URL` | No (has default) | Absolute links in emails + Recurrente redirects. |
| `RECURRENTE_SECRET_KEY`, `RECURRENTE_WEBHOOK_SECRET` | Prod/staging | Billing provider; test/live variants gate sandbox vs real charges. |

## Modelo de IA (ZDR)

El modelo de Claude usado en toda llamada a la API (`src/lib/anthropic.ts`) se lee de
`ANTHROPIC_MODEL` (env), nunca está hardcodeado en un call site — cambiar de modelo es
setear la variable y redesplegar, sin tocar código. `assertZdrModel()` es el gate: solo
dispara la llamada si el modelo está en la allowlist de modelos verificados bajo el
contrato ZDR (`claude-sonnet-5` hoy); cualquier otro valor de `ANTHROPIC_MODEL` lanza
antes de llamar a la API, incluso si viene de config. Para habilitar un modelo nuevo hay
que: (1) reverificar elegibilidad ZDR con Anthropic, (2) agregarlo al `Set` de
`assertZdrModel`, (3) recién entonces apuntar `ANTHROPIC_MODEL` a él. Prueba de que el
swap es puramente de configuración: `src/lib/anthropic.test.ts` (`anthropicModel resuelve
desde configuración...`).

**Contrato ZDR:** el trámite lo completa Anthropic directamente sobre la cuenta ya
entregada al equipo (confirmado por Jose Bustamante, 2026-07-28) — sin acción pendiente
de nuestro lado hoy; solo falta la confirmación formal antes de llevar Módulos 2 y 4
(ingesta Excel, reportes) a producción real (ver CU-868kfv9at).

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
