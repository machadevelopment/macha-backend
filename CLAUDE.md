# CLAUDE.md — Macha Finance

CFO-layer SaaS for SMEs. Multi-tenant, **sensitive financial data**. Two separate repos (not a monorepo): `macha-frontend` (Vercel) and `macha-backend` (Railway). This file documents constraints that are **not inferable from the code**. Keep both repos' copies in sync when a shared rule changes.

## Non-negotiable rules (always)
- **Tenant isolation**: every business query is scoped by `company_id`. `company_id` is resolved server-side from the verified JWT — **never** from the client or an AI model. No query touches a business table without it. The RLS backstop only works if the app connects as `macha_app` (migration `0010_force_rls_and_app_role.sql`), a role that never owns the tables — the owner role (used by migrations) silently bypasses `ENABLE ROW LEVEL SECURITY` entirely (verified against a real instance); `FORCE ROW LEVEL SECURITY` fixes that for the owner too, but only a non-superuser connection.
- **Runtime is Bun, not Node.** Before adding any dependency/SDK, verify Bun compatibility. Do not add Node-only libs.
- **ORM is Drizzle, not Prisma.** Never introduce Prisma.
- **No passwords/secrets in the DB.** Identity is WorkOS/AuthKit; there is no password/hash column anywhere.
- **AI provider is Anthropic Claude only, under a signed ZDR contract.** No OpenAI/other vendors. Never persist prompts or customer financial data in the provider. Re-verify ZDR eligibility on any model change. Initial model: `claude-sonnet-5`.
- **Append-only ledgers** (`ai_usage_events`, `credit_transactions`, `admin_audit_log`, `report_versions`, `industry_template_versions`, `payments`, `inventory_movements`, `company_column_profiles`): insert only, never UPDATE/DELETE. Corrections are compensating rows. This is only a real DB-level guarantee if the app connects as `macha_app`, not the owner role — Postgres table owners always retain implicit UPDATE/DELETE regardless of `REVOKE ... FROM PUBLIC` (verified; there is no "FORCE" for privileges the way there is for RLS).
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
     (clientes, proveedores, productos, tiendas) no llegan al modelo. Los archivos
     reales de PYME son volcados operativos completos, no exportes contables: ~31% de las filas.
     El sesgo es deliberado hacia PAGAR DE MÁS — `unknown` siempre va al modelo, porque
     descartar de más pierde contabilidad del cliente en silencio.
     **EXCEPCIÓN: la firma `existencias` ya no se tira** (CU-868krkfrh, 2026-08-16). Seguía el
     mismo camino que el resto y era el bug "Inventario no carga datos con ningún archivo":
     producción descartaba 211 filas de inventario por carga, en cada una de las tres empresas.
     Ahora `firmaDeCatalogo()` dice CUÁL catálogo es y esa hoja va a `lib/inventory-import.ts`,
     **sin pasar por el modelo** — sus encabezados son predecibles y mandarla a la IA desharía
     lo que este mismo filtro vino a lograr. La cantidad del archivo se trata como un CONTEO,
     no como un movimiento: SKU nuevo → alta con existencia inicial, SKU conocido → ajuste por
     la diferencia, sin diferencia → no se escribe nada. Por eso resubir el archivo semanal no
     duplica el stock. Todo pasa por `recordMovement`, nunca se escribe `quantity_on_hand`.
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
  **`INTAKE_OUTPUT_TOKEN_BUDGET` NO es el reloj** (corregido 2026-08-19, medido). Versiones
  anteriores de este archivo decían que subirlo "vuelve a alargar la espera": es falso. El total
  de tokens de salida de una hoja no depende del tamaño del lote, así que
  `tandas × s_por_llamada ≈ filas × tokens_por_fila / (rendimiento × concurrencia)` — el lote se
  cancela. Medido sobre `Ventas` (18.034 filas, ~115 tok/s, concurrencia 10): lotes de 57 filas
  → 16,1 min; de 88 → 16,3 min; de 90 → 16,7 min. Su trabajo real es **mantener suficientes
  lotes para llenar la ventana de concurrencia** (con lotes de 888 filas son 21 llamadas en 3
  tandas de ~471 s = 23,6 min, porque ya no hay con qué llenar los 10 cupos) y quedar debajo de
  `max_tokens`. El 40.000 → 4.000 de agosto fue una mejora real, pero por ese motivo.
  **Promotion is PARTIAL (Keneth's call, 2026-08-07 — migration `0020`)**: clean rows promote on their own, only
  flagged rows are held back for internal review, and each one promotes incrementally as staff resolves it. A
  `promoted` document with `flagged_count > 0` is the normal state, not a contradiction. The SQL atomicity still
  holds (one tx, all-or-nothing) but over the *promotable* rows, not the whole document — the previous rule
  ("no row promotes while any flagged row is unresolved") turned internal review, meant to be the exception, into
  the mandatory path for every upload: 0 rows in production against 3,195 in staging, measured 2026-08-06.
  Idempotency is therefore **per row** (`staging_rows.promoted_at`), not per document — the old document-level
  lock blocked the legitimate second pass. Revert = soft-delete by `document_id`.
- **Consenso de hoja: se deja de preguntar lo ya contestado** (`lib/sheet-consensus.ts`,
  2026-08-19). Los seis pasos de arriba deciden qué NO mandar al modelo; este decide **cuándo
  dejar de mandarle una hoja que ya se entendió**, y es el ahorro más grande medido hasta ahora.
  El recibo que lo motiva (`CasaViva_Registro_Operaciones_2025-2026.xlsx`, House Products,
  documento `055d9a75-64b4-49f8-a391-3834346a4d67`): 216 llamadas, USD 15,82, 14 minutos — y
  **205 de esas llamadas fueron UNA hoja** (`Ventas`, 18.034 filas) devolviendo
  `transaction/revenue` en todas las filas, sin una excepción. Se pagó por que un modelo dijera
  "esto es una venta" dieciocho mil veces.
  - **Sonda → decisión → resto.** `SONDA_LOTES` (3) lotes de cada hoja van al modelo
    **repartidos a lo largo de ella** (primero/medio/último, `elegirSonda`) y NO los primeros:
    las hojas vienen ordenadas por fecha y el renglón de TOTAL vive al final, que es justo lo
    que una sonda del arranque nunca ve. Si los tres coinciden, los lotes restantes se resuelven
    en código con el veredicto que el modelo ya dio.
  - **Los umbrales están del lado caro** y son producto, no ajuste (hay un test que los fija):
    ≥3 lotes, ≥120 filas, el veredicto dominante ≥98 % de las filas, ≤2 % de `skip`, y mapa con
    fecha **y** monto. Medido: `Ventas` da 100 % y cortocircuita; `Gastos_Operativos` —13
    categorías, la más frecuente cubre 11 %— no se acerca y sigue yendo entera al modelo, que es
    lo correcto porque ahí cada fila sí requiere criterio.
  - **Candado por fila** (`filaAptaParaCortocircuito`): la fila tiene que traer fecha y monto
    legibles en las columnas del mapa. Un renglón de TOTAL o un título no pasa y va a revisión
    interna con confianza 0 — igual que la fila que el modelo no logró clasificar. Nunca se
    descarta ninguna.
  - **El lote local NO escribe `ai_usage_events`** (no hubo llamada) pero **sí debita crédito**:
    los créditos miden el trabajo hecho para el cliente, no nuestro costo con el proveedor, y
    cambiar eso movería el precio del producto — es decisión de Jose, no del worker.
  - **La reanudación reconstruye la sonda** (3 llamadas): el consenso vive en memoria y dar por
    bueno uno que este proceso nunca vio sale gratis hasta que clasifica mal media hoja.
  - Simulado contra el archivo real con el pipeline nuevo: **213 → 15 llamadas, USD 15,56 →
    1,10, ~17,5 → ~1,6 min, 0 filas a revisión.**
- **La categoría se unifica por hoja** (`CanonizadorDeCategorias`, mismo archivo). No es ahorro,
  es un bug de datos: cada lote pide su clasificación por separado y nada obligaba a que dos
  lotes de la misma hoja bautizaran igual el mismo concepto. En producción no lo hicieron —
  sobre filas indistinguibles de `Ventas`: `sales` (17.763), `ventas` (88), `product_sales` (88).
  Los dos 88 son exactamente el tamaño de lote de esa corrida, o sea que fueron LOTES, no filas.
  House Products tiene hoy tres rubros en su dashboard donde hay uno. Es el mismo modo de fallo
  que `assertMismoMapa` ya cubre para el mapa de columnas, sobre el otro campo que el modelo
  decide por lote. Se colapsa por **sinonimia** (ES/EN + plurales + palabras genéricas), nunca
  por (entidad, tipo): las 13 categorías de `Gastos_Operativos` son todas `opex` y colapsarlas
  dejaría al cliente sin su pantalla de gastos. **El canonizador nunca inventa un nombre** —solo
  mapea sobre uno que ya apareció en esa hoja—, así que si la tabla de sinónimos se queda corta
  el peor caso es no unificar, no unificar mal. Y **habilita el cortocircuito**: sin unificar,
  los tres lotes de `Ventas` contaban como tres veredictos y ninguno llegaba al 98 %.
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
- **La escala del DATO DE APOYO estaba fuera de la alineación al prototipo, y ahí estaba el "todo se ve muy grande"** (CU-868ktknbq, 2026-08-19). `styles/tokens-prototipo.test.ts` fija los COLORES contra `juanrodriguezbz/mvp-macha` y dice explícitamente que los tokens de densidad quedan fuera; por ese hueco entró el reporte de QA. Medido contra el prototipo, la tipografía titular NO era el problema: etiqueta (11px/500), cifra de KPI (24px/600) y relleno de tarjeta (16px) **ya coincidían**. Lo que no coincidía:
  - **El breakpoint del grid de KPIs**: pasábamos a 5 columnas en `2xl` (1536px), el prototipo en `lg` (1024px). Una MacBook de 14" da **1512px** — 24px por debajo del corte —, así que en la máquina donde se demuestra el producto caían a 3 columnas, los KPIs ocupaban dos filas y la gráfica de tendencia quedaba abajo del pliegue. Ese solo carácter era el cambio de mayor efecto visible de todo el ticket.
  - **El dato de apoyo de la tarjeta**: cifra exacta, frase de ayuda y "vs mes anterior" iban en `body` (14px/1.5) donde el prototipo usa 10px con interlínea apretada. Tres líneas de 21px contra 13px, más el chip del delta en su propia fila, dejaban la tarjeta en ~258px contra ~152px. Tokens nuevos: `micro` (10px) y `delta` (12px).
  - **El título de pantalla**: el panel seguía en `text-h1 font-normal` (27px/400) — más grande Y más delgado que el prototipo (24px/600), o sea que ocupaba más y mandaba menos. `pagetitle` (20px/600) se había creado cinco semanas antes en CU-868kt8bg0 **con la nota escrita de que el dashboard ya no usa `h1`**, y el dashboard siguió usándolo. Por eso ahora hay test (`styles/densidad-prototipo.test.ts`) y no solo un comentario: el comentario ya falló una vez.
  Pendiente y NO hecho acá: el rail derecho del panel. En el prototipo trae tres consejos con contenido real (una cobranza vencida con monto y días de mora, una oportunidad de venta con su valor, el net burn del mes); en el nuestro es un texto que explica lo que el producto *haría* más dos alertas del mismo tipo repetidas. Eso no es escala, es contenido, y probablemente pesa más en la sensación de "no se asimilan" que cualquier píxel.
- **Regla de los DOS VERDES** (CU-868knx0vh, aprobada por Jose 2026-08-11). El color sigue sin decorar, pero ahora hay dos verdes con roles que no se pisan. **Verde de marca** (salvia `#A0AF9A` + gradiente, token `brand`): dice "esto es Macha" — Insight Point, acentos, pantallas de vitrina, cabecera de reportes. **Verde funcional** (`#16A34A`, token `success`): dice "este dato va bien" — deltas, chips, series. Rojo funcional para lo negativo. **Prueba de fuego: si el color dice "va bien o mal" es funcional; si dice "esto es Macha" es salvia.** Nunca el mismo tono para ambos, y el salvia **nunca sobre un dato**. El color de estado nunca aparece SOLO. **Matizado en CU-868ktknbq (2026-08-19): texto+fondo+borde era UNA forma de cumplirlo, no la única.** Lo que la regla protege es que el estado no dependa únicamente del color —quien no distingue verde de rojo tiene que poder leerlo igual—, así que basta cualquier canal redundante. El delta de una tarjeta de KPI lo cumple con la FLECHA (↗ ↘) y por eso ya va sin caja (`DeltaBadge presentation="inline"`): el chip se llevaba una fila entera de cada tarjeta. **El chip sigue siendo el default y sigue siendo obligatorio donde no hay flecha** — un rótulo de estado a secas (`key-alerts-card`) no tiene otro canal que el fondo y el borde. Hay test que lo fija (`styles/densidad-prototipo.test.ts`): si alguien quita la flecha del delta en línea, falla.
- **Tipografía: SF Pro Display AUTO-HOSPEDADA** (`next/font/local`, cuatro pesos desde `app/fonts/`, 1.3 MB). Inter salió del bundle; la SF del sistema queda de respaldo en `--font-ui-stack` por si el `.otf` no carga. ⚠️ **Riesgo de licencia asumido por el dueño:** SF Pro es de Apple y su licencia **no cubre servirla desde web** — solo diseñar con ella para plataformas Apple. Está documentado en `lib/fonts.ts`; revertir es editar ese archivo y borrar `app/fonts/`, porque ningún componente conoce el nombre de la fuente.
- **Regla mono, revisada**: las **cifras salieron** de `JetBrains Mono` (era el cambio de mayor impacto visual del rediseño: la monoespaciada hacía leer el producto como herramienta de desarrollador). Los números van en la tipografía de interfaz con `tabular-nums` — que es lo que de verdad los alinea en tablas, un ajuste independiente de la familia. `font-mono` **sigue siendo obligatorio** para eyebrows y labels en mayúscula con tracking, que son rasgo de identidad y no dato.
  **Acotada, no deshecha (CU-868ktknbq, 2026-08-19):** lo que hacía leer el producto como herramienta de desarrollador era la CIFRA GRANDE en monoespaciada, y esa sigue en la tipografía de interfaz — hay test que lo fija. Pero el prototipo (fuente de verdad visual) sí usa mono en el **dato de apoyo pequeño**: la cifra exacta bajo el KPI y el delta, a 10-12px. Ahí el ancho fijo ayuda a leer una columna de dígitos en vez de disfrazar el producto, así que vuelve. La frase de ayuda (`hint`) es prosa y no lo lleva.
- **Formatting is locale-aware and centralized**: use `formatMoney/formatDate/formatPct` helpers over `Intl.*` (`es-GT`/`en-US`); always show explicit currency code (GTQ/USD). Never format inline.
- **Component split**: Tremor Raw for charts + KPI/indicator cards; shadcn/ui for everything else. Don't use two libs for the same role. **Known deviation**: F1 actually installed `@tremor/react` (the classic npm package), not real Tremor Raw (copy-paste source) — decided 2026-07-27 to avoid a mid-epic chart-library migration; restyled on our own tokens. Revisit only if `@tremor/react` becomes a real blocker.
- Auth UI is WorkOS AuthKit (hosted); the app verifies session, it does not implement login/password/email-verification.
- Do **not** use `localStorage`/`sessionStorage` in artifacts/prototypes; use React state.

Rough layout: `app/(app)/` (customer), `app/admin/` (backoffice), `components/ui/` (shadcn), `components/charts/` (Tremor), `lib/format/`, `lib/i18n/`, `styles/globals.css` (tokens).

## Environments
**⚠️ NO HAY STAGING. `main` despliega a PRODUCCIÓN** (decisión de Keneth, verificada contra Railway el 2026-08-17). Versiones anteriores de este archivo describían "production + persistent staging (synthetic data only)" y **eso nunca fue cierto**: el proyecto `macha-backend-staging` en Railway tiene solo Postgres y Redis, sin servicio de aplicación, y sin deploy desde 2026-08-04. El único backend que corre es el del proyecto `macha-production`, y despliega desde `main`.

Consecuencias que hay que tener presentes porque no son las que el flujo original suponía:
- **Un merge `dev → main` llega a clientes reales**, no a un ensayo. No existe el "promote manual a prod" del FRENO 3: `main` YA es prod.
- **Las migraciones de schema auto-aplican sobre la base de producción** en ese mismo deploy, sin pasada previa en otro entorno. De ahí que importe tanto que no pidan locks (ver la nota de `schema_migrations` arriba).
- **La QA se hace sobre la contabilidad de clientes reales.** Es deliberado mientras el producto está en fase de prueba; subir un archivo de prueba a una empresa real deja filas reales en su dashboard, y revertirlo es un soft-delete por `document_id`.
- **Recurrente corre con la clave `sk_test_`, a propósito**: todavía no hay cobros. La `sk_live_` está guardada al lado en `RECURRENTE_SECRET_KEY_LIVE_GUARDADA`. El día que se facture hay que promoverla **junto con** su `RECURRENTE_WEBHOOK_SECRET` — van en par, cambiar una sola rompe la verificación del webhook.

**Ramas:** **`dev` is the integration branch: `feat/*` branches off `dev` and merges back into `dev`** (agent-merged once checks pass, no per-ticket human review). `main` solo recibe merges desde `dev` por épica completada, y **lo mergea el dueño, nunca el agente** — esa regla no cambia; al contrario, importa más ahora que se sabe que `main` es producción. CI gate: lint + test (GitHub Actions) + local pre-push hook. Vercel sí genera previews efímeras por PR. Backups: Railway native + nightly `pg_dump` to S3 (30-day rolling). See `flux.md` for the full process.

## Docs (planning source of truth, in this workspace)
`PRD.md` · `data model.md` · `design guide.md` · `flux.md` (proceso/ramas). Read the relevant one before changing behavior in that area.

> **Nota (auditoría 2026-07-28):** versiones anteriores de este archivo y de `flux.md` §10 listaban también `docs/map.md`, `docs/architecture-report.md` y `docs/issues/*` como contexto obligatorio. **Ese directorio `docs/` nunca existió en el workspace** — las decisiones de arquitectura viven en `PRD.md` §5 y en los comentarios de cabecera del propio código (que documentan el "por qué" verificado contra instancias reales, p. ej. `src/db/migrations/0010_force_rls_and_app_role.sql`). Referencias eliminadas para no mandar a leer archivos inexistentes.
