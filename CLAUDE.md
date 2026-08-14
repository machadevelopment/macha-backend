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
- **Las migraciones llevan registro (`schema_migrations`) y NO se reaplican todas en cada deploy** (2026-08-14). Antes sí, y la idempotencia bastaba para la corrección — pero **no cambiar nada igual cuesta LOCKS**. Un deploy que solo tocaba documentación murió con `deadlock detected` en `ALTER TABLE company_users FORCE ROW LEVEL SECURITY`: las migraciones corren mientras el contenedor **viejo** sigue atendiendo tráfico, el `ALTER` pide AccessExclusiveLock y la request viva tiene AccessShareLock. Postgres mató a la migración; **pudo haber matado la query del cliente**. Y `0012` hace DROP+CREATE de la política de cada tabla y de **cada partición por empresa**, así que el costo por deploy CRECÍA con la cantidad de clientes. El registro guarda `sha256` del contenido: editar una migración la vuelve a aplicar, no tocarla la salta. **Excepción única y explícita: `0010`, marcado `@reaplicar-siempre`**, porque su bloque GRANT/REVOKE es un no-op hasta que un operador crea `macha_app` a mano y el camino documentado para activarlo es redesplegar; por eso además sale temprano si los privilegios ya están puestos. **Toda migración nueva que active RLS usa `macha_asegurar_rls()`** (`0000_aa_rls_helpers.sql`), que no toca la tabla si ya está — el `ALTER` directo vuelve a poner la bomba en cada deploy a cambio de nada. `migrate.ts` corre con `lock_timeout` de 5 s y un reintento: mientras una migración ESPERA el lock, toda query nueva sobre esa tabla se encola detrás, así que el peor caso de esperar de más no es tardar, es congelar la tabla.
- **Excel ingestion is async via pg-boss.** Rows land in a single staging table.
  **Seis pasos ANTES del modelo, y el ORDEN importa** (2026-08-12/14) — cada uno existe porque
  el anterior no cubre su caso, y saltárselos es volver a pagar lo que ya se pagó:
  1. **Encontrar el encabezado real** (`lib/sheet-header.ts`). Va PRIMERO porque todo lo demás
     se indexa contra la fila 0: el pre-filtro la mira, el mapa de columnas se arma contra ella
     y los índices que devuelve el modelo apuntan a ella. Un Excel hecho por una persona trae
     dos líneas de título antes de la tabla, y leerlas como nombres de columna **no falla
     nada visible**: los datos salen de las columnas equivocadas. El sesgo va a NO MOVERSE — un
     candidato tiene que ganarle a la fila 0 y a las tres de abajo, porque elegir mal descarta
     una fila real Y desplaza el mapa.
  2. **Forma de hoja** (`lib/sheet-shape.ts`): distingue una TABLA de un REPORTE. Cinco señales
     geométricas (encabezado con huecos + celdas vacías, ancho >40, columnas que son meses,
     nombres de columna repetidos). Los reportes con bloques a lo ancho —una fila = un cliente
     con doce meses al lado— no son movimientos y solo devuelven filas marcadas.
  3. **Pre-filtro por encabezados** (`lib/sheet-classifier.ts`): las hojas de catálogo
     (clientes, proveedores, inventario, productos, tiendas) no llegan al modelo. Los archivos
     reales de PYME son volcados operativos completos, no exportes contables: ~31% de las filas.
     El sesgo es deliberado hacia PAGAR DE MÁS — `unknown` siempre va al modelo, porque
     descartar de más pierde contabilidad del cliente en silencio.
  4. **Cabecera y detalle del mismo dinero** (`lib/sheet-duplication.ts`, 2026-08-14). Un archivo
     real trae `OrdenesCompra` (60 filas, Q 2.707.318) y `LineasOC` (220 filas, Q 2.707.318):
     **la misma plata a dos granularidades**. Si las dos producen movimientos, las compras del
     cliente se cuentan DOS VECES. Se conserva la CABECERA (sus filas traen contraparte y fecha;
     el detalle no) y se pierde el desglose por producto — el mensaje al cliente lo nombra.
     **Corre solo sobre las hojas que sobrevivieron a 2 y 3**: contra todas, el catálogo
     `Productos` empataba con `Ventas` y habría descartado 520 ventas reales. Y las columnas de
     FECHA se excluyen de la comparación — un serial de Excel vale ~45.000, así que sesenta
     fechas suman más que la columna de dinero de su propia hoja.
  5. **Huella por fila** (`lib/row-fingerprint.ts` + tabla `ingested_rows`, migración `0024`):
     el cliente resube su contabilidad completa cada semana. La huella lleva un **ordinal**
     contado por CONTENIDO, no por posición, para que dos ventas idénticas el mismo día no se
     colapsen y reordenar el archivo no lo haga parecer nuevo. Se registran en la MISMA
     transacción que el lote: registrarlas antes perdería las filas para siempre si la llamada
     falla.
  6. **Planificador de lotes** (`lib/sheet-batching.ts`): el tamaño sale del presupuesto de
     tokens de SALIDA, no del conteo de filas.
  **Corpus de hojas reales** (`lib/corpus-hojas-reales.test.ts`): 19 hojas de archivos de
  clientes de verdad con su veredicto esperado. Es lo que atrapó dos errores que los tests
  sintéticos no veían — un fixture recortado a 12 columnas destruye las señales de ancho y de
  períodos. El generador verifica que cada muestra reproduzca el veredicto de la hoja completa.
  **La hoja de movimientos se lista explícita**, no se deriva de la clasificación: si el filtro
  se rompe, un test derivado se rompe con él y pasa igual.
- **El modelo NO devuelve los valores de la fila** (2026-08-12). Devuelve el mapa de columnas
  UNA VEZ por hoja y por fila solo `{i, e, t, c, cf}`; los valores los arma el código indexando
  la celda (`lib/row-assembly.ts`). El motivo: el 95,7% del recibo eran tokens de salida, y
  siete de los nueve campos que devolvía ya se los había mandado el backend en la fila cruda.
  Medido: 290 → 41 tokens de salida por fila, ~50 min → ~1 min por archivo.
  **Dos reglas tácitas que el modelo aplicaba y ahora viven en código**: el monto entra en
  **positivo** (la dirección la lleva `type`, y `staging-rules` exige positivo) y las fechas
  son **seriales de Excel** con época 1899-12-30, acotados a un rango de plausibilidad de
  negocio para que un MONTO en la columna equivocada no se convierta en una fecha creíble.
  **`INTAKE_OUTPUT_TOKEN_BUDGET` es el reloj, no solo el tope de corte**: subirlo agranda los
  lotes y vuelve a alargar la espera, aunque el costo total no cambie.
  **Promotion is PARTIAL (Keneth's call, 2026-08-07 — migration `0020`)**: clean rows promote on their own, only
  flagged rows are held back for internal review, and each one promotes incrementally as staff resolves it. A
  `promoted` document with `flagged_count > 0` is the normal state, not a contradiction. The SQL atomicity still
  holds (one tx, all-or-nothing) but over the *promotable* rows, not the whole document — the previous rule
  ("no row promotes while any flagged row is unresolved") turned internal review, meant to be the exception, into
  the mandatory path for every upload: 0 rows in production against 3,195 in staging, measured 2026-08-06.
  Idempotency is therefore **per row** (`staging_rows.promoted_at`), not per document — the old document-level
  lock blocked the legitimate second pass. Revert = soft-delete by `document_id`.
- **Ninguna fila desaparece en silencio** (auditoría 2026-08-12). Tres garantías que el código
  hace cumplir, cada una por un fallo que ya se observó o que no dejaría rastro:
  1. **Cobertura**: se compara lo devuelto contra lo enviado. `skip` es un veredicto EXPLÍCITO
     del esquema — antes el modelo ignoraba una fila omitiéndola, y eso era indistinguible de
     un fallo. Medido: una corrida devolvió 772 de 800 filas y la siguiente, mismo archivo,
     las 800. Lo que falta se reintenta UNA vez; lo que ni así se cubre va a staging con
     `confidence: 0` (→ revisión interna), nunca a la basura.
  2. **Desplazamiento de índices** (`hayDesplazamiento`): si el modelo numerara desde 1, cada
     veredicto se aplicaría a la fila ANTERIOR y la contabilidad del lote quedaría corrida con
     datos plausibles. Se aborta con tipo propio. Saltarse la primera fila NO lo dispara.
  3. **Mapa de columnas único por hoja** (`assertMismoMapa`): cada lote lo pide por su cuenta,
     y si dos difieren media hoja entra leyendo otra columna de dinero. El primer lote fija el
     canónico y el chequeo corre ANTES de la transacción, así que un mapa discrepante no
     escribe nada.
- **`batchConcurrency` sale de un límite MEDIDO, no supuesto** (2026-08-12). Las cabeceras
  `anthropic-ratelimit-*` de cualquier respuesta dan los límites de la cuenta: 400k tokens de
  salida/min, 2M de entrada/min, 1.000 requests/min. Un archivo completo usa ~33k de salida
  por minuto — el 8 %. Por eso 10 y no 5; el tope duro de 46 está en el config porque el
  límite es de CUENTA y varias empresas subiendo a la vez lo comparten.
- **Rate limiting**: per-company token-bucket in Redis + queue-depth gate reading pg-boss's own tables. No custom rate-limit table.
- **Every Claude call inserts one `ai_usage_events` row** tagged `kind` (`excel`/`chat`/`insight`/`report_generation`/`excel_correction`). `insight` debits credits; `excel_correction` never does. **Los tokens de caché van en columnas aparte** (`cache_read_input_tokens`/`cache_creation_input_tokens`, migración `0025`): la API NO los incluye en `input_tokens`, así que omitirlos subestimaba `cost_usd` — se cobran a 0,1x (lectura) y 1,25x (escritura) de la tarifa de entrada.
- **S3 stores binaries; DB stores only keys** (`documents.s3_key`, `report_versions.s3_render_key`). Access via short-lived presigned URLs after tenant/role check. Prefix keys by `company_id`.
- Chat: `company_id` injected server-side; tool-use (no RAG, no vector DB).

Rough layout: `src/modules/<module>/` (routes+services), `src/db/schema/` (Drizzle tables), `src/db/migrations/` (drizzle-kit + raw SQL), `src/queue/` (pg-boss + thin queue interface), `src/lib/` (auth/jwks, s3, resend, anthropic), `src/guards/`.

## Frontend — `macha-frontend` (Next.js)
Stack: Next.js (App Router) · React 18 · TypeScript strict · Tailwind CSS · shadcn/ui (Radix) · Tremor Raw (charts/KPIs, on Recharts) · Lucide React · `next-themes` · i18n ES/EN · SF Pro Display auto-hospedada (`next/font/local`) + JetBrains Mono (`next/font/google`).

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
- **Regla de los DOS VERDES** (CU-868knx0vh, aprobada por Jose 2026-08-11). El color sigue sin decorar, pero ahora hay dos verdes con roles que no se pisan. **Verde de marca** (salvia `#A0AF9A` + gradiente, token `brand`): dice "esto es Macha" — Insight Point, acentos, pantallas de vitrina, cabecera de reportes. **Verde funcional** (`#16A34A`, token `success`): dice "este dato va bien" — deltas, chips, series. Rojo funcional para lo negativo. **Prueba de fuego: si el color dice "va bien o mal" es funcional; si dice "esto es Macha" es salvia.** Nunca el mismo tono para ambos, y el salvia **nunca sobre un dato**. El color de estado sigue apareciendo siempre como texto+fondo+borde juntos, nunca solo texto de color.
- **Tipografía: SF Pro Display AUTO-HOSPEDADA** (`next/font/local`, cuatro pesos desde `app/fonts/`, 1.3 MB). Inter salió del bundle; la SF del sistema queda de respaldo en `--font-ui-stack` por si el `.otf` no carga. ⚠️ **Riesgo de licencia asumido por el dueño:** SF Pro es de Apple y su licencia **no cubre servirla desde web** — solo diseñar con ella para plataformas Apple. Está documentado en `lib/fonts.ts`; revertir es editar ese archivo y borrar `app/fonts/`, porque ningún componente conoce el nombre de la fuente.
- **Regla mono, revisada**: las **cifras salieron** de `JetBrains Mono` (era el cambio de mayor impacto visual del rediseño: la monoespaciada hacía leer el producto como herramienta de desarrollador). Los números van en la tipografía de interfaz con `tabular-nums` — que es lo que de verdad los alinea en tablas, un ajuste independiente de la familia. `font-mono` **sigue siendo obligatorio** para eyebrows y labels en mayúscula con tracking, que son rasgo de identidad y no dato.
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
