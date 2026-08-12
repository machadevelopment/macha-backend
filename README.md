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

### Arranque local: cómo consigue su fila en `users` quien levanta esto por primera vez

Pregunta que costó un bug crítico (CU-868kjkfdf): la base recién migrada tiene el
esquema completo pero `users`, `companies`, `company_users` y `staff` en cero, y los
guards rechazan con `403 No Macha account for this identity` a quien no tenga fila.

**No hay que insertar nada a mano.** Desde CU-868kjkfdf, `identity.derive` da de alta la
identidad sola la primera vez que aparece (ver `src/lib/user-provisioning.ts`): entras
por AuthKit, el frontend llama a `/me/memberships` o a `/register` con tu token, y la
fila se crea ahí. `users` es solo el espejo local de la identidad — **no concede acceso
a nada**: los datos de negocio los gobierna `company_users` y el backoffice `staff`.

Para que ese alta funcione hace falta `WORKOS_API_KEY`, porque el access token de WorkOS
no lleva email ni nombre y `users.email` es `NOT NULL`. Sin la clave, un usuario **ya
existente** entra sin problema; uno nuevo recibe un error que lo dice explícitamente.

Dos cosas que siguen siendo manuales, porque conceden permisos y no deben ser
automáticas:

- **Ser `staff`** (acceso a `/admin/*`): insertar la fila en `staff` a mano contra la
  base, con el `user_id` que ya se creó solo.
- **Datos de demo**: `bun run db:seed` monta empresa, plantillas de industria y reglas
  de crédito. No crea usuarios.

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
| `APP_DATABASE_URL` | Prod/staging | Restricted `macha_app` role the app actually connects as. Falls back to `DATABASE_URL` if unset (RLS/append-only become no-ops without it) — ver el runbook de abajo. |
| `REQUIRE_ISOLATED_DB_ROLE` | No (default `false`) | `true` hace que el arranque ABORTE si el rol de la app no está aislado. Se setea en staging/prod **después** de completar el runbook de `macha_app`. |
| `REDIS_URL` | Yes | Rate limiting (Railway plugin). |
| `INTAKE_*` | No (has defaults) | Excel intake caps, CU-868kfv972. |
| `RATE_LIMIT_*` | No (has defaults) | Token-bucket + queue-depth gate values. |
| `CREDIT_*` | No (has defaults) | Credit ratio/allotment, provisional startup values. |
| `WORKOS_JWKS_URL`, `WORKOS_CLIENT_ID` | Yes | JWT verification (JWKS), no password/session logic here. |
| `WORKOS_API_KEY` | Yes | Alta JIT de una identidad nueva (CU-868kjkfdf): el access token no trae email/nombre y `users.email` es NOT NULL, así que el perfil se le pide a la Management API por el `sub` ya firmado. Una llamada por usuario en toda su vida. |
| `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL` | Yes | ZDR contract only; model kept in config, never hardcoded. |
| `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | Yes | Binaries only; DB stores keys, not files. |
| `RESEND_API_KEY`, `RESEND_FROM_EMAIL` | Yes | Transactional email. |
| `SENTRY_DSN` | Prod/staging | No-op without it (local/dev/CI never set it). En un despliegue, faltar = servir sin monitoreo; el arranque lo avisa (§Observabilidad). |
| `SENTRY_ENVIRONMENT` | No (se deduce) | Etiqueta del entorno en cada evento. Por omisión `RAILWAY_ENVIRONMENT_NAME` y luego `NODE_ENV`. |
| `APP_BASE_URL` | No (has default) | Absolute links in emails + Recurrente redirects. |
| `BACKUP_RETENTION_DAYS` | No (has default) | Nightly `pg_dump` → S3 retention (30d). |
| `RECURRENTE_SECRET_KEY`, `RECURRENTE_WEBHOOK_SECRET` | Prod/staging | Billing provider; test/live variants gate sandbox vs real charges. |

> **Una variable vacía es un valor, no una ausencia.** Guardar la clave sin valor en la
> UI de Railway/Vercel deja `''`, no `undefined`. Por eso los defaults de `src/lib/env.ts`
> y de `src/config/*` se resuelven con `||` y nunca con `??`: con `??` una
> `APP_DATABASE_URL=` vacía resolvía a `''`, y `postgres('')` no falla — se conecta a los
> defaults de libpq, así que la app arrancaba y **`/health` seguía devolviendo 200**
> mientras toda query moría. Cubierto por `src/lib/env.test.ts`.

## Healthcheck del despliegue

Apunta el healthcheck de la plataforma a **`/health/db`**, no a `/health`. `/health` es
solo liveness: responde 200 sin tocar Postgres, así que un deploy con la base mal
configurada se marca sano igual. `/health/db` ejecuta un `SELECT 1` y falla con 5xx si la
conexión no sirve, que es justo lo que debe frenar el deploy.

## Observabilidad (Sentry) — runbook de despliegue (CU-868kmr1tb)

El código está completo y es **no-op sin DSN** a propósito: `src/lib/sentry.ts` arranca el
SDK en `src/index.ts` y `src/app.ts` reporta en `onError` todo lo que no sea 4xx. Lo que
falta es **configuración de plataforma**, y no puede hacerla el repo.

> **Estado verificado el 2026-08-12** contra las variables reales del servicio
> `macha-backend` del proyecto `macha-production`: `SENTRY_DSN` **no está**. Producción
> corre sin captura de errores. `NODE_ENV=production` sí está (CU-868kmqqdr), así que en
> cuanto haya DSN los eventos saldrán etiquetados bien.

Pasos, en orden. **Los ejecuta el dueño** — requieren una cuenta de Sentry y credenciales
que no viven en ningún archivo del repo:

1. **Crear DOS proyectos en Sentry**, uno por entorno. No es cosmético: es la regla no
   negociable de credenciales de no-prod separadas. Un DSN compartido mezcla los errores
   de staging con los de un cliente real en el mismo tablero.
   - Plataforma: **Bun** (o Node.js si la org no la ofrece) — `@sentry/bun`.
   - Nombres sugeridos: `macha-backend-prod` y `macha-backend-staging`.
2. **Copiar el DSN de cada proyecto**: Sentry → *Settings → Projects → `<proyecto>` →
   Client Keys (DSN)*.
3. **Setear `SENTRY_DSN` en Railway**, proyecto `macha-production`, servicio
   `macha-backend` → *Variables* → `SENTRY_DSN=<DSN de macha-backend-prod>`. Guardar
   dispara redeploy; si no, redesplegar a mano (el DSN se lee en el arranque).
   - `SENTRY_ENVIRONMENT` **no hace falta aquí**: Railway inyecta
     `RAILWAY_ENVIRONMENT_NAME=production` y el SDK la usa sola. Setearla solo si se
     quiere un nombre distinto del de la plataforma.
4. **Verificar en el log del deploy.** Con DSN sale
   `[sentry] captura de errores activa — environment='production'.`; sin él, sale a
   gritos `[sentry] SIN MONITOREO DE ERRORES: ...`. Ese aviso es la red que faltaba: la
   auditoría del 2026-08-05 no tuvo ninguna señal de que Sentry estuviera apagado.
5. **Prueba de humo**: provocar un 5xx real y confirmar que el evento llega al proyecto
   correcto, con `environment: production` y stack trace legible.

> **El backend de staging todavía no existe como servicio.** El proyecto
> `macha-backend-staging` de Railway solo tiene Postgres y Redis (verificado 2026-08-12).
> El proyecto de Sentry de staging se crea igual —para no dejar a medias la separación—
> pero su DSN no tiene dónde setearse hasta que ese servicio se despliegue.

## Activación del rol `macha_app` (CU-868kjbw5h) — runbook de despliegue

> **Una instancia nueva NO está aislada hasta completar estos pasos.** `APP_DATABASE_URL`
> vacía es un fallo de configuración **silencioso**: la app funciona idéntico, pero el
> `REVOKE UPDATE, DELETE` de los 6 ledgers append-only no aplica (Postgres le conserva
> esos privilegios al dueño de la tabla, de forma implícita e irrevocable, y no existe un
> "FORCE" para privilegios como sí lo hay para RLS). Esto se hace **una vez por entorno**.

Desde el arranque, la app verifica esto contra su conexión real y lo dice en el log
(`src/lib/db-role-check.ts`), además de reportarlo a Sentry. Pero **no aborta** mientras
`REQUIRE_ISOLATED_DB_ROLE` no esté en `true` — el último paso del runbook es justamente
activar esa red.

1. **Confirmar migraciones.** Que `0010`, `0011` y `0012` se aplicaron limpias en el
   deploy. `0010` re-corre en cada deploy a propósito: su bloque `GRANT`/`REVOKE` es un
   no-op (con `NOTICE`) hasta que el rol existe.
2. **Crear el rol** (operador, directo contra Railway — requiere `CREATEROLE`, que el
   usuario de app normalmente no tiene, por eso no va en una migración). La contraseña
   se genera aquí y **no va en ninguna migración ni archivo de env**:
   ```sql
   CREATE ROLE macha_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS
     PASSWORD '<generada>';
   ```
3. **Re-aplicar `0010`** (redeploy o `bun run db:migrate`) para que el `GRANT`/`REVOKE`
   surta efecto ahora que el rol existe. Este segundo pase es el que se olvida.
4. **Setear `APP_DATABASE_URL`** apuntando a `macha_app` y redeployar. Verificar que la
   app arranca, que el log dice `aislamiento OK`, y que un usuario con membresía activa
   recibe 200 (es lo que rompía `CU-868kj3utc`, ya arreglado en `0012`).
5. **Verificar contra la instancia real** que el aislamiento muerde:
   ```
   VERIFY_OWNER_DATABASE_URL=postgres://owner@... \
   VERIFY_APP_DATABASE_URL=postgres://macha_app@... \
   bun run verify:isolation
   ```
   Comprueba las precondiciones del rol, que `UPDATE` sea rechazado en los 6 ledgers, y
   que una sesión con `app.company_id` de la empresa A no vea filas de la B (con
   contraprueba de que sí ve las propias, para que un 0 por ceguera no pase por
   aislamiento). Es de solo lectura.
6. **Setear `REQUIRE_ISOLATED_DB_ROLE=true`** en ese entorno. A partir de ahí, una
   regresión de configuración aborta el arranque en vez de degradarse en silencio.

Producción es un paso explícito y separado (**FRENO 3**, lo ejecuta el dueño), no un
efecto secundario de haberlo hecho en staging.

## Verificación de aislamiento prod/no-prod (CU-868kfvaz6)

- **Credenciales separadas por entorno** (criterio 1): verificado por código — cada
  servicio externo (WorkOS, Anthropic, S3, Redis, Recurrente, Sentry) lee su valor de
  una env var nativa de la plataforma (ver tabla arriba), sin ningún valor
  hardcodeado ni compartido entre ambientes en el repo.
- **Ningún secreto versionado** (criterio 3): verificado — `.gitignore` bloquea
  `.env`/`.env.*` salvo `.env.example` (sin valores reales).
- **Staging solo con datos sintéticos** (criterio 2): **no verificable desde este
  entorno** — requiere inspeccionar el contenido real de la base de staging.
  `AUDIT_TARGET_DATABASE_URL=postgres://... bun run audit:staging-data` lista
  empresas, dominios de email y conteos de filas para revisión manual; el juicio de
  "esto es sintético" lo da una persona, no el script. Registra el resultado en el
  ticket de ClickUp.

## Simulacro de restauración (CU-868kfvata)

Verificación mensual de que los backups (`pg_dump` nocturno → S3, `CU-868kfvar3`)
sirven de verdad, no solo que se generan:

1. Provisiona un Postgres **desechable** de verificación (contenedor local o instancia
   Railway de un solo uso) — nunca un ambiente real.
2. `RESTORE_TARGET_DATABASE_URL=postgres://... bun run restore:drill` — descarga el
   dump más reciente de `backups/postgres/` en S3, corre `pg_restore`, y un sanity
   check (conteo de filas en `companies`/`transactions`/`ai_usage_events`).
3. Registra el resultado (fecha, backup restaurado, sanity check) como comentario en
   el ticket de ClickUp del simulacro de ese mes.
4. Cadencia: el primero antes de la entrega (criterio de aceptación del proyecto),
   luego mensual — agenda un recordatorio o cron externo; este repo no dispara el
   simulacro automáticamente (a diferencia del backup, que sí es un job programado)
   porque restaurar es intrínsecamente manual/verificado por una persona, no algo
   para automatizar sin supervisión.

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
  queue/            # pg-boss + workers (excel-ingest, report-tick/generate,
                    #   alert-evaluate, email-send, db-backup)
  modules/          # feature modules (routes + services): ingestion, metrics,
                    #   insights, chats, reports, me, health, billing/*, admin/*
scripts/
  provision_tenant.sql  # per-company PARTITION OF (run at onboarding)
  seed.ts
```

## Estado (auditoría 2026-07-28)

F1–F7 + M8 implementados y mergeados a `main` (staging). `typecheck`/`lint`/`test`
verdes (104 tests). Guards, RLS, particionado, ingesta Excel, dashboard, chat,
reportes/alertas, panel admin, billing Recurrente y backups nocturnos están en el
código, no son placeholders.

**Deuda conocida y verificada** (cada una con ticket en ClickUp, lista MACHA FINANCE
2.0) — se documenta aquí porque no se infiere leyendo el código feliz:

- Los emails de reporte y de alerta construyen URLs que **no resuelven** a una ruta
  real del frontend (`/reports/{versionId}` cuando la ruta espera un `reports.id`;
  `/alerts/{id}` no existe como ruta).
- Los caps de filas/hojas del intake **solo se aplican a `.xlsx`** — `.csv`/`.xls`
  pasan solo por el cap de tamaño (`lib/xlsx-inspect.ts` solo entiende OOXML).
- `revertDocument()` (`lib/promotion.ts`) no tiene endpoint que lo exponga: la
  reversión existe como función pero es inalcanzable desde la API.
- El token-bucket `read` está configurado pero **ninguna ruta lo consume** (solo `ai`,
  en chat/insight). La API de lectura general no tiene rate limiting.
- Capacidades definidas en `lib/permissions.ts` sin endpoint: `manage_members`,
  `change_roles`, `configure_alerts`, `delete_company`, `revert_upload` (cliente) y
  `topup_credits` (staff).
- `/metrics` hace N+1 (meses × 4 tipos en serie) y `/ar-ap` carga todas las facturas
  abiertas a memoria para agrupar en JS.
- La definición de "margen" (`revenue - cogs`) es un placeholder sin confirmar por
  negocio — ver `modules/metrics/index.ts`.
