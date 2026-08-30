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
                       # Corren en un clon LIMPIO: `bunfig.toml` precarga
                       # test-setup/env-de-pruebas.ts, que pone el piso de env.
                       # Antes fallaban 29 sin un `.env` local que no está en el repo.
bun run test:db:up     # Postgres efímero para integración (docker compose)
bun run test:integration  # migraciones + rol macha_app + tests de RLS/append-only/guards
bun run test:db:down   # baja el Postgres de test y borra su volumen
bun run db:generate    # drizzle-kit generate (schema migrations)
bun run db:migrate     # apply migrations
bun run db:seed        # data/seed scripts (manual, separate from schema migrations)
```

Conventions & gotchas:
- **`bun test` tiene que pasar en un clon RECIÉN CLONADO, y no pasaba** (reportado y arreglado
  2026-08-30). `lib/env.ts` exige `DATABASE_URL` **al importarse** y media docena de tests la
  importan de rebote (`src/app.test.ts` monta la app entera para fijar qué rutas son públicas),
  así que sin la variable son **29 tests en rojo** con `Missing required env var: DATABASE_URL`
  y nada que explique qué hacer. **No fallaba para todos, y eso es lo que lo hizo durar**: la
  máquina del dueño tiene un `.env` gitignoreado que Bun carga solo, y CI la define a mano en
  `ci.yml`. O sea que el requisito estaba escrito en los dos únicos lugares que nadie mira —un
  YAML de CI y un archivo que no se versiona— y en ninguna parte del repo. Tres archivos de
  test lo parchaban con `process.env.DATABASE_URL ??=` en su primera línea, lo cual **solo
  funciona si ese archivo corre antes que los demás**: Bun comparte el proceso entre archivos,
  así que era una moneda al aire según el orden de carga. Ahora `bunfig.toml` precarga
  `test-setup/env-de-pruebas.ts`, que es **exclusivo de tests** (no lo ve `bun run dev` ni el
  bundle) y usa `??=` para que un `.env` real o el `TEST_DATABASE_URL` del job de integración
  siempre ganen. La URL apunta a un puerto muerto a propósito: si un test unitario intentara
  conectar de verdad, tiene que fallar fuerte y no colgarse contra una base que alguien tenga
  levantada.
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
  **Siete pasos ANTES del modelo, y el ORDEN importa** (2026-08-12/14, ampliado 2026-08-24) — cada uno existe porque
  el anterior no cubre su caso, y saltárselos es volver a pagar lo que ya se pagó:
  0. **El esquema relacional del libro** (`lib/sheet-relations.ts`, 2026-08-24). Se calcula
     sobre las hojas que sobrevivieron a los pasos 2 y 3 —igual que la detección de
     duplicados— y es lo único que mira el libro COMO CONJUNTO: qué columnas son
     identificadores y **qué hoja apunta a qué otra**. De ahí salen dos decisiones que ningún
     filtro por hoja podía tomar: una hoja cuya clave es única por fila y a la que otra
     referencia es una **tabla de entidades** (no produce movimientos: va a inventario), y una
     hoja que apunta a otra hoja de movimientos **no vuelve a reconocer su ingreso**. Ver el
     punto de "una factura emitida" más abajo. Motivo: `Concesionaria_Guatemala` (CarsGT,
     documento `bb769e8e`) puso Q 16 M de ingreso inventado en el dashboard de un cliente —
     260 vehículos EN STOCK como costo de ventas (240 por segunda vez, su costo ya venía en
     `Ventas`) más 81 cuentas por cobrar devengando un ingreso ya contado. **Es por
     ESTRUCTURA y no por vocabulario a propósito**: la respuesta corta era agregar `vin` e
     `idvehiculo` a la firma `existencias`, y eso arregla concesionarias mientras garantiza
     que la joyería (`certificado`), la inmobiliaria (`matricula`) y la maquinaria
     (`numeroserie`) vuelvan a fallar igual. La firma busca vocabulario de inventario
     FUNGIBLE porque nació de una cafetería; un identificador único que otra hoja referencia
     es la misma señal en todos los rubros. **No reemplaza a `sheet-duplication.ts`**: ese
     detecta cabecera/detalle por SUMAS iguales, que es contar dos veces de otra forma.
     `inventory-import.ts` gana el camino SERIALIZADO (`mapearInventarioSerializado`): sin
     columna de cantidad, cada fila vale UNA unidad — un VIN es un vehículo.
     **Y EL VEREDICTO DEL ESQUEMA NUNCA BASTA SOLO** (mismo día, unas horas después): una hoja
     va a inventario si el esquema la marca como entidad **Y** `classifySheet` NO la ve como
     `financial`. Sin esa segunda condición el mecanismo se comió las ventas de un cliente —
     Jose subió el archivo de HeladosGT y su hoja `Ventas` (435 filas) se registró como stock,
     dejando el dashboard con Q 58.334 de ingreso contra Q 1.797.772 de gasto. El agujero es
     exacto: una hoja es entidad si otra la referencia y ella no referencia a nadie, y en el
     archivo que motivó el mecanismo `Ventas → Inventario` la excluía — pero **ese enlace es
     una casualidad de ESE libro**. Sin hoja de inventario, `Ventas` queda terminal en el
     grafo. La forma del grafo no puede distinguirlas ni en principio: en los dos casos la hoja
     referenciada es la que CONTIENE a la otra (el inventario contiene lo vendido, las ventas
     contienen lo que quedó por cobrar). Una hoja con columna de fecha Y de monto es un libro de
     movimientos y ninguna señal estructural debería poder silenciarla.
     **LA SEÑAL ES LA CONTRAPARTE, y costó tres intentos** (`pareceLibroDeMovimientos`, mismo
     día): (1) `classifySheet === 'financial'` funcionaba de CASUALIDAD — ese veredicto exige
     una columna de dinero que coincida EXACTO, y de las quince de `Ventas` la única que
     coincide es `Utilidad Bruta`; con "Margen" la hoja daba `unknown` y se perdía igual.
     (2) "tiene fecha Y dinero" por prefijo es robusto para las ventas pero se come el caso
     original: un inventario de concesionaria trae `Costo Adquisicion` y `Fecha Ingreso`, así
     que **ninguna señal de dinero puede separarlos**. (3) Lo que sí los separa es semántico:
     un MOVIMIENTO involucra a alguien —se le vende a un cliente, se le compra a un proveedor—
     y una lista de existencias no. **Y el set corregido se calcula UNA vez**: `esquema.entidades`
     tiene DOS consumidores (el enrutado a inventario y la regla de "la factura no devenga si su
     venta ya está registrada") y parchar solo el primero dejó a HeladosGT sumando Q 58.334 de
     ingreso duplicado — medido en producción DESPUÉS de ese primer arreglo.
  1. **Encontrar el encabezado real** (`lib/sheet-header.ts`). Va PRIMERO de los que miran una
     hoja sola porque todo lo demás se indexa contra la fila 0: el pre-filtro la mira, el mapa
     de columnas se arma contra ella y los índices que devuelve el modelo apuntan a ella. Un
     Excel hecho por una persona trae dos líneas de título antes de la tabla, y leerlas como
     nombres de columna **no falla nada visible**: los datos salen de las columnas
     equivocadas. El sesgo va a NO MOVERSE — un candidato tiene que ganarle a la fila 0 y a
     las tres de abajo, porque elegir mal descarta una fila real Y desplaza el mapa.
     **DOS FORMAS DE DESTACAR, no una** (2026-08-24): o el candidato se ve bastante más
     encabezado que las filas de abajo, **o rompe el TIPO de sus propias columnas** (dice
     "Fecha" donde su columna trae seriales). La segunda vía no es un refuerzo, es lo único
     que funciona en una tabla con columnas descriptivas: ahí las filas de datos tienen
     `unicos` y `cobertura` en 1,00 igual que el encabezado, el único discriminante que queda
     pesa 0,35 y el margen exigido era 0,2 — **el encabezado necesitaba 1,014 sobre un máximo
     de 1,00 y perdía por 0,014**. Medido en las CINCO hojas de `Concesionaria_Guatemala`: se
     quedaba en la fila 0, o sea el título. Y como `classifySheet` recibía entonces un
     encabezado de UNA celda y lo declaraba ilegible, **se cayeron a la vez el pre-filtro, la
     firma de `existencias` y la forma de hoja**: las cinco hojas fueron al modelo y el
     archivo costó USD 0,90 por mil filas, el más caro de la semana. Este paso no es uno de
     seis: es el que decide si los otros cinco existen.
  2. **Forma de hoja** (`lib/sheet-shape.ts`): distingue una TABLA de un REPORTE. Cinco señales
     geométricas (encabezado con huecos + celdas vacías, ancho >40, columnas que son meses,
     nombres de columna repetidos). Los reportes con bloques a lo ancho —una fila = un cliente
     con doce meses al lado— no son movimientos y solo devuelven filas marcadas.
  2-bis. **Antes de descartar un reporte ancho: ¿se puede convertir en movimientos?**
     (`lib/sheet-unpivot.ts`, 2026-08-30). `analizarFormaDeHoja` acierta al decir "esto no es
     una tabla" y aun así descartarlo **pierde plata real**: la matriz de gastos operativos de
     una PYME —concepto a la izquierda, un mes por columna— es la ÚNICA fuente de sus gastos,
     no hay otra hoja de donde sacarlos. Medido: **Q 75.465,90 en el archivo real de
     KapePrueba**, que es exactamente lo que suma la propia columna `Total` de esa hoja. Y
     descartarla no es "conservador": deja el resultado del período **INFLADO**, o sea que la
     cifra que sí se muestra está mal. El cliente ve utilidad neta = utilidad bruta, o sea que
     el producto le dice que operar su negocio no cuesta nada.
     ⚠️ **Es el módulo con más potencial de daño del pipeline**: `Estado_Resultados` y
     `Flujo_Caja` tienen EXACTAMENTE la misma forma y despivotarlos duplicaría los ingresos.
     Por eso es una **lista blanca** y ante cualquier duda devuelve `null` y la hoja sigue el
     camino que ya seguía. **Su peor caso es no mejorar nada; nunca es contar de más.** Las
     cuatro guardas se exigen JUNTAS porque cada una sola tiene contraejemplo:
     1. **Ningún valor negativo.** El signo es la firma de un estado financiero (el costo se
        resta del ingreso); una matriz de gastos es toda de la misma naturaleza y va toda en
        positivo. No alcanza sola: hay estados escritos todo en positivo.
     2. **Ningún renglón con vocabulario de AGREGADO** (utilidad, saldo, margen, resultado,
        ventas netas, costo de ventas…). La lista es de agregados y no de rubros, y por eso no
        crece sin fin: el vocabulario contable de los renglones calculados es cerrado, el de
        los rubros no. Es **todo-o-nada por hoja**: si la hoja es un estado, sus renglones de
        gasto TAMBIÉN están en la hoja de detalle que los origina.
     3. **≥3 columnas de mes, sin repetir.** Un mes repetido significa bloques a lo ancho
        (`Enero Costo`, `Enero Venta`) y ahí una celda no dice QUÉ es ese número.
     4. **Sus conceptos NO son ya las categorías de otra hoja de movimientos.** La cuarta salió
        del corpus real y es la que ninguna de las otras tres podía ver, porque **la señal no
        está en la hoja sino en el LIBRO**: `02_Restaurante_ElFogon` trae `CostosYGastos` (180
        filas de detalle con columna `Categoria`, Q 1.094.637) y `ReporteMensualGastos` (6
        categorías × 12 meses, Q 1.082.854, subtítulo *"Resumen ya consolidado, uso interno de
        gerencia"*). Mirando la hoja sola es **indistinguible** de la matriz legítima de
        KapePrueba y pasaba las tres primeras guardas, duplicando los gastos del restaurante.
        `sheet-duplication` tampoco lo atrapa: los totales difieren 1,08 % —el detalle cubre 20
        meses y el resumen 12— contra su umbral del 1 %. Medido: **100 % de solape de conceptos
        en el restaurante contra 0 % en KapePrueba**. La comparación es contra las hojas que
        **producen movimientos**, no contra todas — contra todas, los conceptos de KapePrueba
        aparecen en su `Estado_Resultados` y su `Punto_Equilibrio` (derivados que no se
        procesan) y el solape también daba 100 %, o sea que la señal se apagaba entera.
     5. **Ningún renglón es la ARITMÉTICA de los otros** (2026-08-30). Las guardas 2 y 4 fallan
        las dos contra un estado escrito con etiquetas GENÉRICAS: `Ingresos / Egresos /
        Diferencia`. Ninguna está en la lista de agregados —ni puede estarlo: "ingresos" es
        también el nombre legítimo de un rubro— y sus conceptos no aparecen en otra hoja, así
        que el solape da cero. Pasaba las cuatro y duplicaba toda la contabilidad; la única
        razón por la que no explotó en la primera corrida es que ese negocio daba pérdida y el
        negativo lo atrapó la guarda 1. **La señal no es cómo se LLAMAN los renglones sino cómo
        se RELACIONAN**: un estado financiero es por definición un conjunto donde alguno se
        calcula a partir de los otros, y `Ingresos = Egresos + Diferencia` es la misma identidad
        que `Utilidad = Ventas − Costos` con otras palabras. Eso se mide, y a diferencia de una
        lista de palabras no se queda corta con el próximo rótulo que alguien invente.
        Dos formas, y la diferencia decide qué hacer: **suma de TODOS los demás** → se rechaza
        la hoja (es un estado, y sus renglones también viven en las hojas de detalle);
        **suma de un BLOQUE CONTIGUO de arriba** → se excluye solo ese renglón (es un subtotal
        anidado, `Servicios` = Agua + Luz, y rechazar la hoja perdería alquiler y sueldos, que
        son gastos reales). El bloque contiguo no es arbitrario: es como se escribe un subtotal
        en una hoja de cálculo. **La tolerancia es 0,1 %** y eso importa — con 0,5 % apareció un
        falso positivo enseguida, en una matriz de seis rubros donde `Sueldos` (2.800) quedaba a
        0,36 % de la suma de los otros cinco (2.790) por casualidad, y la hoja entera se
        rechazaba. Una identidad contable la calcula una fórmula: es exacta salvo redondeo.
     La columna `Total`/`Promedio` **no** se despivota (no son meses) y la fila `TOTAL` se
     excluye sin descalificar la hoja. **La fecha es el día 1 y no el último**: con el último,
     el mes EN CURSO queda fechado en el futuro y se sale de cualquier filtro "hasta hoy" del
     dashboard — se perdería justo el mes que el cliente mira.
     **TRIMESTRES Y SEMESTRES también son períodos** (`Q1 2026`, `T1`, `1er trimestre`, `S1
     2026`): hay negocios que presupuestan así, y sin reconocerlos la hoja ni siquiera se
     detectaba como reporte — caía al camino normal, se quedaba sin columna de fecha y
     desaparecía (Q 77.280 medidos). Se mapean al PRIMER MES de su período para que la fecha
     caiga dentro y el filtro del dashboard la encuentre. Un `Acumulado Q1` NO se reconoce: es
     el subtotal de los meses de al lado. ⚠️ `pareceNombreDePeriodo` (sheet-shape) y
     `mesDeEncabezado` (sheet-unpivot) **tienen que coincidir**, o pasa lo peor de los dos
     mundos: la hoja se marca como reporte y después no se puede despivotar, o sea que se
     descarta igual. Hay test sobre 24 etiquetas.
     **El mínimo de períodos baja de 3 a 2 SOLO con año explícito en todas las etiquetas.** Una
     matriz semestral tiene exactamente dos columnas; `S1 2026` no admite otra lectura, mientras
     que `Enero` a secas puede ser el nombre de una persona o de una sucursal.
     **Y el despivotado es un RESCATE ante CUALQUIER descarte, no solo ante el de "reporte".**
     Se intentaba únicamente tras `analizarFormaDeHoja`, que exige cuatro columnas de período;
     una matriz de dos o tres caía al filtro siguiente y desaparecía sin dejar una sola fila
     marcada. Intentarlo antes de tirar la hoja es correcto por construcción: a esa altura ya se
     iba a la basura, así que solo puede AGREGAR datos, y las cinco guardas corren enteras.
  3. **Pre-filtro por encabezados** (`lib/sheet-classifier.ts`): las hojas de catálogo
     (clientes, proveedores, productos, tiendas) no llegan al modelo. Los archivos
     reales de PYME son volcados operativos completos, no exportes contables: ~31% de las filas.
     El sesgo es deliberado hacia PAGAR DE MÁS — `unknown` siempre va al modelo, porque
     descartar de más pierde contabilidad del cliente en silencio.
     **EXCEPCIÓN: la firma `existencias` ya no se tira** (CU-868krkfrh, 2026-08-16). Seguía el
     mismo camino que el resto y era el bug "Inventario no carga datos con ningún archivo":
     producción descartaba 211 filas de inventario por carga, en cada una de las tres empresas.
     ⚠️ **Y una CARTERA DE CLIENTES que no se reconoce como catálogo se vuelve ingresos falsos**
     (2026-08-28, mismo archivo de KapePrueba). `Clientes_B2B` —`Cliente · NIT · Tipo · Contacto
     · Teléfono · Condiciones · Venta neta acumulada · Unidades · Última compra · Saldo por
     cobrar`— daba 2 coincidencias contra el mínimo de 3 de la firma `contactos`: faltaba
     `nombre`, porque la columna se llama "Cliente". Se fue al modelo, y el modelo hizo lo único
     que podía con ella: leyó `Última compra` como la fecha y `Saldo por cobrar` como el monto.
     Los **Q 13.362,75** que Jose vio en el dashboard son la suma exacta de esa columna, o sea
     **cartera pendiente de cobro presentada como ingresos del trimestre** — y fueron la ÚNICA
     cifra que llegó. `nit` y `condiciones` entraron a la firma porque son de la misma naturaleza
     que el resto (cómo se FICHA a una contraparte, no cómo se registra un hecho) y no aparecen
     en una hoja de movimientos: una línea de venta no lleva las condiciones de crédito de su
     cliente. La lección que generaliza: una columna ACUMULADA o de SALDO es tan legible como una
     de monto, así que una hoja derivada que llegue al modelo no falla — produce cifras
     plausibles y equivocadas.
     Ahora `firmaDeCatalogo()` dice CUÁL catálogo es y esa hoja va a `lib/inventory-import.ts`,
     **sin pasar por el modelo** — sus encabezados son predecibles y mandarla a la IA desharía
     lo que este mismo filtro vino a lograr. La cantidad del archivo se trata como un CONTEO,
     no como un movimiento: SKU nuevo → alta con existencia inicial, SKU conocido → ajuste por
     la diferencia, sin diferencia → no se escribe nada. Por eso resubir el archivo semanal no
     duplica el stock. Todo pasa por `recordMovement`, nunca se escribe `quantity_on_hand`.
     **LAS FILAS SE AGRUPAN POR SKU ANTES DE APLICARSE** (auditoría 2026-08-24): la fila del
     archivo es **(SKU, tienda)** y el artículo del inventario es el SKU. El de una joyería trae
     210 filas para 42 productos —una por tienda— y cada una se trataba como un CONTEO nuevo que
     pisaba al anterior: `JYL-ANI-0001` con 130·42·35·1·0 quedaba en **0 unidades donde hay
     208**. El rastro lo dejaba escrito y nadie lo leía ("Conteo importado del archivo (24 → 9)",
     cuatro veces para el mismo artículo). Tocaba a empresas reales: 55 artículos de Electro
     Hogar. Se SUMA porque `inventory_items` tiene un artículo por SKU y no por (SKU, tienda) —
     no hay dónde guardar el desglose— y la pregunta que contesta la pantalla es "cuánto tengo".
     **Se pierde el detalle por tienda y hay que decirlo**; la alternativa cambia el modelo de
     datos y es decisión de producto. La primera fila del grupo aporta los atributos (nombre,
     costo) y las demás solo su cantidad: tomar los de la última haría que el nombre dependiera
     del orden de las tiendas. El camino serializado no se ve afectado — cada serie es única, así
     que cada grupo tiene una sola fila.
  ⚠️ **Y el resumen transpuesto también viene con el período escrito como FECHA** (2026-08-30).
     La señal 6 de `sheet-shape` reconoce "Enero" y "ene-26", no lo que una fórmula de Excel
     pone de verdad en esa columna: **el serial 46023, o sea 2026-01-01**. Es el agujero de
     KapePrueba con el período escrito de otra forma, y su costo es duplicar la facturación
     entera (Q 364.788 contados dos veces contra el libro de prueba). La guarda contra el falso
     positivo es la **coherencia de DÍA**: un marcador de período no elige el día —lo pone la
     fórmula y sale siempre el 1, o el último del mes— y un movimiento sí, así que ocho
     movimientos reales repartidos en ocho meses no caen acá. "Una fila por mes" a secas sería
     demasiado laxo y perdería la contabilidad de una PYME chica.
  4. **Cabecera y detalle del mismo dinero** (`lib/sheet-duplication.ts`, 2026-08-14). Un archivo
     real trae `OrdenesCompra` (60 filas, Q 2.707.318) y `LineasOC` (220 filas, Q 2.707.318):
     **la misma plata a dos granularidades**. Si las dos producen movimientos, las compras del
     cliente se cuentan DOS VECES. Se conserva la hoja **cuyas filas se bastan solas** —las que
     traen CONTRAPARTE y fecha— y se pierde el desglose por producto; el mensaje al cliente lo
     nombra. **Corre solo sobre las hojas que sobrevivieron a 2 y 3**: contra todas, el catálogo
     `Productos` empataba con `Ventas` y habría descartado 520 ventas reales. Y las columnas de
     FECHA se excluyen de la comparación — un serial de Excel vale ~45.000, así que sesenta
     fechas suman más que la columna de dinero de su propia hoja.
     ⚠️ **La conservada NO se elige por tener menos filas, y confundirlo vació un libro entero**
     (2026-08-28, archivo de demo de KapePrueba). El criterio era "menos filas = cabecera", que
     siempre fue un PROXY de la autosuficiencia; nadie verificaba la premisa. El libro traía su
     propio consolidado (`Resumen_Mensual`, 11 filas, *"Consolidado automático desde la hoja
     Ventas"*), así que empatar con `Ventas` (481 filas) y `Compras` (43) **no era casualidad
     sino su naturaleza**: se descartaron las 524 filas reales para conservar el resumen. Y un
     resumen empata contra TODAS las hojas de detalle del libro, así que UNA hoja así lo vacía
     entero. Lo que separa una cabecera de un resumen no es el tamaño —el resumen es más chico
     que la cabecera y la cabecera más chica que el detalle— sino que **un agregado por período
     no tiene contraparte: no se le vende a "enero"**. La fecha sola no alcanza (la columna `Mes`
     del resumen son seriales de Excel de verdad). El veredicto de `OrdenesCompra`/`LineasOC` no
     cambia; cambia el motivo, que pasa de un proxy a la premisa.
     ⚠️ **Y la conservada TIENE QUE SOBREVIVIR a los filtros siguientes, o no se descarta nada.**
     La otra mitad del mismo fallo: `Resumen_Mensual` ganaba el dedup y el paso siguiente
     (`noPuedeProducirMovimientos`) lo descartaba por su cuenta. Las dos decisiones eran
     defendibles por separado y juntas dejaron el dashboard del cliente en CERO. Ningún
     reordenamiento de filtros lo arregla en general —siempre hay un filtro después—, así que la
     condición se afirma dentro del dedup (`puedeProducirMovimientos`, que el worker calcula con
     el mismo predicado). El peor caso pasa a ser contar de más, que se VE; se elimina contar
     cero, que no se ve.
     ⚠️ **Y dos hojas con el mismo número de filas y el MISMO dinero AL CENTAVO son una copia**
     (2026-08-30). La regla "sin cabecera clara, no se toca" existe para no elegir al azar entre
     dos hojas distintas, pero ahí no hay nada que elegir: es la misma tabla dos veces —un
     respaldo, una hoja duplicada al exportar— y procesarlas las dos daba la facturación al
     DOBLE. El umbral acá es al CENTAVO y no el 1 % del resto del módulo, y esa diferencia ES la
     regla: dos conjuntos de datos distintos no suman exactamente lo mismo hasta el último
     decimal.
     ⚠️ **`tieneColumnaDeFecha` usa `asDate`, el mismo lector del pipeline** — miraba solo
     objetos `Date` y seriales, así que una hoja con fechas ISO en TEXTO (como las trae cualquier
     archivo que pasó por un CSV) no contaba como autosuficiente, empataba contra un agregado y
     el desempate caía de vuelta al proxy del tamaño. Medido: un libro descartaba sus 48 ventas
     de detalle para conservar una matriz despivotada de 24 filas sin contraparte.
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
  ⚠️ **Leer mal una fecha no borra plata: la MUEVE DE MES, que es peor porque no se ve.** Dos
  agujeros cerrados el 2026-08-30, los dos con el mismo síntoma —la hoja entera desaparece
  antes del modelo, porque sin columna de fecha legible `noPuedeProducirMovimientos` la
  descarta y no quedan ni filas marcadas que alguien pueda revisar:
  - **El mes en palabras solo se leía en inglés.** La lista blanca de `asDate` decía
    textualmente que aceptaba `1 de mayo de 2025`; **nunca funcionó** — el regex reconocía la
    FORMA y después `new Date("15 de enero de 2026")` devolvía `Invalid Date`, porque el
    parseo de nombres de mes no está en la especificación de JavaScript y V8 solo sabe inglés.
    Un producto que factura en Guatemala no sabía leer una fecha escrita en español. Ahora hay
    tabla explícita (ES+EN, con y sin acento, completo y abreviado); delegar en `new Date` o en
    `Intl` haría que el resultado dependiera del motor y del locale del contenedor.
  - **`detectarOrdenDeFecha` era CÓDIGO MUERTO.** Estaba escrito, testeado y documentado con el
    daño que evita ("el 41 % de sus ingresos quedaba mal fechado y el 59 % no quedaba") y **no
    lo llamaba nadie**: el parámetro `ordenDeFecha` de `assemblePayload` no se pasaba desde
    ningún sitio, así que todo el producto leía `DD/MM` siempre. El arreglo estaba escrito y
    nunca se conectó. Un libro exportado en `MM/DD/YYYY` entraba con el 1 de mayo registrado el
    5 de enero, y con suficientes días mayores a 12 la columna bajaba del 80 % exigido y la
    hoja se descartaba entera (176 movimientos medidos). **El orden se decide una vez por HOJA
    y no por lote** —es el modo de fallo que `assertMismoMapa` ya cubre para el mapa de
    columnas: dos lotes con órdenes distintos partirían la hoja en dos calendarios— y se mira
    toda la fila y no solo la columna que el modelo llamó `date`, porque el orden es una
    propiedad del ARCHIVO y así queda resuelto antes de la primera llamada. El filtro de
    supervivencia (`noPuedeProducirMovimientos`) prueba **los dos órdenes** antes de rendirse:
    ahí la pregunta no es cuál es el correcto, sino si la columna puede leerse como fechas.
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
- **Diccionario de CATEGORÍAS por empresa** (`lib/category-dictionary.ts` + tabla
  `company_category_rules`, migración `0034`, acuerdo Keneth–Semi 2026-08-20). El perfil de
  columnas (`0027`) resolvió DÓNDE está cada dato; esto resuelve QUÉ SIGNIFICA el texto de la
  fila. La distinción importa porque un parser del layout puede sacar lo primero y NUNCA lo
  segundo: que "pago a Claro" sea servicios no está en la forma del archivo. Por eso era lo
  único que seguía costando una llamada carga tras carga, con la misma respuesta.
  **No sustituye al consenso de hoja, actúa en otro eje**: el consenso deja de preguntar por
  una HOJA homogénea (`Ventas`, 18.034 filas todas `revenue`); el diccionario sirve justo
  donde el consenso no llega — `Gastos_Operativos`, 13 categorías y la más frecuente cubre el
  11 %, donde cada fila sí requiere criterio pero los CONCEPTOS se repiten entre cargas. El
  diccionario no crece con las filas del archivo sino con los conceptos distintos del negocio,
  que son decenas y se estabilizan.
  **EL CONCEPTO SALE DE `description`, `product` O `counterparty` — EN LOS TRES LADOS**
  (auditoría 2026-08-24). Se exigía `description` y nada más, y eso apagaba el mecanismo
  entero para media base: de las **101 hojas con perfil de columnas en producción, solo 47 la
  traen**, y las que no son las principales — `Ventas` en 7 empresas, `OrdenesCompra` en 4,
  `CuentasPorCobrar` en 3. Un libro de ventas por producto identifica la fila con "Kapel Blend"
  y no escribe una descripción jamás. **El efecto era circular y por eso no se veía**: sin esa
  columna la hoja no APRENDE reglas, así que nunca hay diccionario que aplicar, así que cada
  carga vuelve a pagarle al modelo por las mismas filas — el ahorro estaba apagado justo en la
  hoja más grande de cada archivo. Los TRES lados usan el mismo criterio y tienen que hacerlo:
  el worker al aprender (si aprende por una columna y busca por otra, la regla queda bajo una
  clave que nadie consulta), `resolverLoteConDiccionario` al aplicar, y
  `conceptos-pendientes` al preguntarle al cliente. El ORDEN es `description` (describe el
  HECHO) → `product` (identifica la fila, el dueño la reconoce) → `counterparty` (agrupa más
  grueso: un proveedor factura rubros distintos), y se toma el PRIMERO que exista, nunca una
  concatenación.
  **La autoridad se evalúa ANTES de la versión**: `confirmado_por_cliente` >
  `corregido_por_staff` > `inferido`. Al revés, una inferencia del modelo de la semana
  siguiente pisaría lo que el cliente confirmó y se le volvería a preguntar algo que ya
  contestó — que es exactamente lo que el mecanismo viene a evitar. Staff gana al modelo pero
  NO al cliente: un operador arregla un disparate evidente, pero si el dueño dijo que "Cropa"
  es transporte, sabe algo que nosotros no.
  **Solo aprende con confianza ≥ 0,7 y nunca de un `skip`** (guardar una duda como regla la
  propaga a todas las cargas siguientes), **escribe UNA vez al final del documento** (si la
  carga se cancela a mitad no quedan reglas a medias, y la tabla es append-only: no se podrían
  limpiar) y **un fallo al guardar NO tumba la carga** — la contabilidad ya está promovida y
  correcta; lo que se pierde es el ahorro de la próxima, que se vuelve a aprender sola.
  **Lo que hace hoy** es fijar el nombre de la categoría ENTRE cargas: el canonizador unifica
  dentro de una hoja pero vive en memoria, así que la semana siguiente el mismo concepto podía
  bautizarse distinto y el cliente volvía a tener dos rubros donde hay uno.
  **El ahorro ya está hecho** (`resolverLoteConDiccionario`, 2026-08-20): si TODAS las filas de
  un lote traen un concepto que la empresa ya resolvió, el lote no llama al modelo. Medido en
  `cortocircuito-diccionario-e2e` sobre una hoja de 900 gastos con cuatro conceptos:
  **11 → 4 llamadas, 630 filas resueltas en código**, y el consenso de hoja explícitamente NO
  aplicaba (el veredicto dominante cubría 25 % contra el 98 % que exige). Es el caso para el
  que se construyó.
  - **Es TODO-O-NADA por lote, no "lo que se pueda"**: el lote es la unidad de LLAMADA, así que
    resolver 87 filas en código y preguntar por la restante cuesta lo mismo que preguntar por
    las 88. No hay premio por el 99 %, y sí riesgo en partir el lote.
  - **El veredicto es POR FILA**, no uno para toda la hoja — ahí está la diferencia con el
    cortocircuito de consenso, y es lo que lo hace servir donde cada fila difiere.
  - **El consenso de hoja se pregunta PRIMERO** cuando ambos aplican: su veredicto se midió
    sobre las filas de ESTA carga en tres llamadas que coincidieron, mientras el diccionario
    responde con reglas de cargas anteriores. Ante la misma fila gana la evidencia recién
    medida.
  - **La confianza sale del ORIGEN de la regla y su piso está ATADO a `CONFIDENCE_THRESHOLD`**,
    no escrito a mano: una regla `inferido` solo existe si el veredicto que la creó superó el
    umbral, así que el umbral es lo único afirmable de ella. Si alguien sube el umbral, un 0,7
    literal mandaría a revisión interna todas las filas de todas las cargas, en silencio. Hay
    test que lo fija.
  - **Lo que el candado por fila evita, medido y NO lo que suena**: `filaAptaParaCortocircuito`
    exige fecha y monto legibles, así que un renglón de TOTAL con texto conocido ("Pago a
    Claro") no se resuelve acá. Pero `staging-rules` lo rechazaría igual por `invalid_date`, o
    sea que **el total no acabaría sumado en el dashboard aunque el candado no existiera**
    (comprobado por mutación). Lo que el candado garantiza es que una fila dudosa la JUZGUE el
    modelo en vez de resolverse con una regla que no aplica: sin él, entra a revisión interna
    con una categoría inventada en vez de que el modelo la declare `skip` y no genere fila.
  **El cliente ya contesta lo que no se entendió** (2026-08-20, la otra mitad del acuerdo).
  `GET /documents/:id/conceptos-pendientes` + `POST /documents/:id/conceptos` en el backend, y
  `components/upload/conceptos-pendientes.tsx` en el flujo de subida — **no** en revisión
  interna, por decisión de Semi: es la persona que sabe qué es "Cropa" en su propio libro.
  - **El concepto sale de `description`, `product` o `counterparty` — el primero que exista**
    (reporte de Jose, 2026-08-24: *"da como 60 filas flageadas · resolverlos es un proceso bien
    manual que no debería ser tan complejo"*). Salía SOLO de `description` y toda fila sin ella
    se descartaba en silencio. Medido sobre las **4.686 filas marcadas de producción** que una
    categoría arregla: **1.739 no traen `description`**, y de esas **977 traen `product` y 668
    `counterparty`** — el concepto estaba, en otra columna. Un libro de ventas por producto
    identifica la fila con "Kapel Blend" y uno de compras con el proveedor; ninguno escribe una
    descripción y no tienen por qué. El efecto era el peor posible: la pantalla que existe para
    que el cliente resuelva sus filas con UNA respuesta le mostraba **cero conceptos**, y las
    sesenta se iban enteras a revisión interna. **El GET y el POST usan el MISMO criterio**, y
    esa simetría no es estética: con el POST buscando solo por `description`, el cliente vería
    el concepto, contestaría, y ninguna fila cambiaría — peor que no mostrarlo, porque le diría
    que resolvió algo que sigue igual. El ORDEN tampoco es arbitrario: `description` describe el
    HECHO, `product` identifica la fila y el dueño la reconoce, `counterparty` agrupa más grueso
    (un proveedor factura cosas de rubros distintos). Se toma el primero, nunca una
    concatenación: mezclar producto y proveedor partiría en dos el concepto de una fila que trae
    ambos.
  - **Se pregunta por CONCEPTO, no por fila**, y eso es lo que hace viable la pantalla: un
    archivo con 400 filas marcadas puede tener seis conceptos, y 400 preguntas no las contesta
    nadie — sería revisión interna con otro nombre, en la cara del cliente. El agrupado usa
    `claveDeConcepto`, la MISMA normalización del diccionario; un `GROUP BY lower(...)` en SQL
    agruparía distinto y el cliente vería "Pago a CLARO" y "pago claro" como dos preguntas.
  - **Solo se pregunta lo que una categoría arregla** (`low_confidence`, `missing_category`,
    `invalid_type`). Una fila marcada por `invalid_date` o `invalid_amount` NO aparece: su
    problema es el dato, no el nombre, y mostrarla sería pedir una respuesta que no cambia nada
    dejándole además la impresión de que ya lo resolvió. Esas siguen por revisión interna.
  - **Contestar arregla las filas de ESTA carga**, no solo las próximas: sube la confianza a 1,
    limpia el `flag_reason` y encola la promoción por el MISMO camino que usa staff
    (`encolarPromocionDeLoResuelto`, que por eso se movió de `/admin/staging-rows` a
    `lib/promotion`). Sin eso el cliente contesta y su dashboard sigue igual.
  - **El cliente decide `type` y `category`, NO `entity`**: transacción/factura/cuenta por pagar
    es una forma contable que el sistema ya determinó al leer la fila. Y el desplegable dice "Un
    gasto de operación", no `opex` — el valor que viaja es `opex` porque el esquema lo acota,
    pero nadie que lleve una tienda debería aprender la palabra.
  - **Los montos van SEPARADOS por moneda, nunca sumados.** Las filas de staging traen
    `originalAmount` + `originalCurrency` y todavía no tienen `amount_base` (la conversión pasa
    al promover, con la tasa snapshoteada por fila), así que no hay cifra convertida que sumar.
    Sumar GTQ con USD daría un número que no es ninguna de las dos, al lado del concepto como si
    fuera plata de verdad — un dólar contado como quetzal subestima ~7,7 veces. El ORDEN de la
    lista usa el mayor total de UNA moneda por el mismo motivo.
  - **Lo contestado se quita de la lista en local, sin volver a pedirla**: la promoción va por
    cola, así que un GET inmediato puede devolver los mismos conceptos todavía pendientes y el
    cliente vería reaparecer lo que acaba de contestar.
  **Descartado en la misma conversación, y vale saber por qué**: generar y ejecutar un script
  en el worker. El worker tiene las credenciales de la base, y clasificar no es parsear — un
  script no sabe que "pago a Claro" es servicios. La idea de un sandbox sin red y efímero
  quedó como camino futuro, no como lo que se construyó.
- **La CONFIANZA también se decide por lote, y era el tercer campo sin protección**
  (`ConfianzaPorHoja`, 2026-08-24). El mapa de columnas lo cubre `assertMismoMapa` y la
  categoría el canonizador; la confianza no la cubría nada. Medido en `Concesionaria_Guatemala`
  (CarsGT): la hoja `Ventas`, 240 filas indistinguibles, en tres lotes con **0,92 · 0,75 ·
  0,60 exactos y uniformes dentro de cada lote** — ni una fila difería de sus vecinas. Con
  `CONFIDENCE_THRESHOLD` en 0,7, eso mandó **148 filas buenas a revisión interna**: la misma
  venta pasaba o se marcaba según en qué lote cayó, y el staff que abría la cola veía "Mazda 3,
  Q 200.400, venta_vehiculos" sin nada que revisar. **Una confianza uniforme en todo el lote es
  un juicio sobre el LOTE, no sobre la fila**, y usarla para decidir el destino de filas
  individuales es convertir ruido en señal. Se sube al techo que el modelo ya le dio a ESE
  veredicto en ESA hoja — nunca se baja, nunca cruza veredictos ni hojas, y **si dentro del
  lote hubo variación no se toca nada**: esa variación es el juicio por fila que el prompt
  pide. Lo que sigue protegiendo a la fila es `staging-rules`, que valida fecha, monto y
  categoría aparte de la confianza. Depende del ORDEN (se compara contra el máximo visto hasta
  ese momento, porque las filas se insertan lote a lote): si el lote más confiado llega último
  no arregla nada, o sea que el peor caso es lo que ya pasaba y no hay forma de quedar peor.
  Es la misma concesión que el canonizador con "el primero que llegó gana".
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
  el peor caso es no unificar, no unificar mal. **La tabla salió de AUDITAR producción**
  (2026-08-24): 143 categorías reales, con 24 rubros de `opex` en House Products, 20 en
  HeladosGT y 19 en CarsGT — los pares ES/EN son la mayor parte de lo que sobra. Dos hallazgos
  de esa auditoría que no se ven leyendo código: el modelo a veces pega **el tipo como prefijo**
  (`opex.software` junto a `software`, 69 filas de U3 TECH) y eso se quita del NOMBRE y no solo
  del concepto, porque es lo que el cliente lee; y **el plural rompía la unificación** —
  `comisiones`→`comisione`, `supplies`→`supplie`— así que `lemaDe` prueba las formas `-es` e
  `-ies` antes de rendirse. **Los DESGLOSES no se unifican y es decisión, no olvido**:
  `utilities_water` no se colapsa contra `utilities` ni `payroll_admin` contra `payroll`. Un
  dueño puede querer ver el agua separada de la luz; traducir es objetivo, decidir que dos
  rubros distintos son uno es del cliente. **Y se unifica también por CONTENCIÓN**
  (2026-08-24): si las palabras significativas de un nombre están todas dentro de las de otro,
  es el mismo concepto con un matiz de más. Verificado en producción sobre una concesionaria
  que produjo TRES nombres para el mismo gasto, uno por lote — `import_customs` (11 filas),
  `importacion_aduanas` (8) e `import_customs_duties` (6) — y el daño fue doble: tres rubros
  donde hay uno, y como contaban como veredictos distintos el tercero **no pudo heredar la
  confianza** que el modelo ya le había dado al mismo concepto, así que sus 6 filas se fueron a
  revisión. Hacen falta **≥2 lemas** compartidos (`gasto` está fuera de las genéricas a
  propósito, y con uno solo absorbería a `gasto_ventas`) y **contención, no intersección**:
  `servicios_publicos` y `servicios_profesionales_externos` comparten `utility` y NO se unen,
  porque cada uno tiene una palabra propia. Hay test, y hubo que corregirlo: el primer caso que
  escribí pasaba por la guarda de cardinalidad y dejaba la mutación "comparten alguna palabra"
  en verde. Y **habilita el cortocircuito**: sin unificar,
  los tres lotes de `Ventas` contaban como tres veredictos y ninguno llegaba al 98 %.
- **Una factura emitida produce SU INGRESO además de la cuenta por cobrar — UNA vez** (2026-08-19, acotado el 2026-08-24). Jose subió `U3TECH_Demo_Datos_Ampliado` y reportó "no logra reconocer los ingresos". Medido: `Facturacion_Clientes` —1.403 filas, **USD 4.840.744**, la facturación real de esa empresa— se clasificó `invoice`, se promovió entera, y el dashboard mostró **CERO ingresos**, porque `lib/rollups.ts` suma `revenue` únicamente de `transactions`. El dato estaba bien leído, bien clasificado y bien guardado, y aun así el cliente veía su negocio en cero. **No era un error de clasificación**: una factura pendiente sí es una cuenta por cobrar; lo que estaba mal era la premisa de que fuera SOLO eso — emitirla reconoce el ingreso (devengo) Y crea el derecho de cobro, dos caras del mismo hecho. Afectaba a **toda empresa que factura en vez de cobrar al mostrador** (servicios, consultoría, software); una cafetería no lo notaba porque sus ventas ya son transacciones. Es el mismo patrón que la venta con costo: una fila del archivo produce dos del ledger. El ingreso se devenga en la fecha de **emisión**, nunca en la de vencimiento —usarla lo movería de período, que es el error de la contabilidad de caja— y el payload se **arma de nuevo** con `targetEntity: 'transaction'` en vez de copiar el de la factura: las dos formas son distintas y un spread deja la fila sin `date`, marcada entera por `invalid_date` (pasó en el primer intento). Una `bill` NO produce ingreso: sería registrar como ingreso lo que la empresa debe.
  **La acotación (2026-08-24)**: la regla se conserva entera y solo se le agrega "una vez".
  `CuentasPorCobrar` de CarsGT trae 81 facturas que apuntan por `ID Venta` a ventas que la
  hoja `Ventas` YA registró como ingreso, y devengarlas otra vez sumó **Q 3.039.680** que
  nadie facturó dos veces. Una hoja de cobros es un ESTADO de la venta, no una venta más.
  Quién lo decide es el esquema del libro (`ventaYaRegistradaEnOtraHoja`), **no el nombre de
  la hoja** — "CuentasPorCobrar" es una convención y el próximo cliente la llamará "Cobros".
  **El caso que motivó la regla sigue intacto y hay test que lo fija**: `Facturacion_Clientes`
  de U3TECH no apunta a ninguna hoja de ventas, así que la condición es falsa y su ingreso se
  devenga como debe. La factura devenga por defecto; solo deja de hacerlo cuando el mismo
  libro demuestra que ese ingreso ya está contado.
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
- **El crédito de la ingesta se cobra UNA vez por CARGA, no por lote** (reporte de Jose,
  2026-08-24). Se debitaba dentro de `procesarLote`, así que con la regla activa —`fixed`, 25
  créditos— un archivo de 77 lotes cobraba **1.925 créditos por una sola carga** y dejaba a la
  empresa en **-1.675**. Medido en producción: Electro Hogar 77 lotes, Prueba Modo Test 22,
  CarsGT 14. Una empresa nueva con 250 créditos incluidos quedaba en negativo con su PRIMER
  upload. **La regla ya decía lo correcto**: `estimateRequiredCredits` con `ruleType: 'fixed'`
  devuelve 25 sin mirar las unidades — lo que estaba mal era llamarla una vez por lote. El
  débito vive ahora ANTES del bucle de lotes concurrentes, que es el único punto donde se sabe
  que la carga va a procesarse y donde la comprobación de idempotencia no compite con los diez
  lotes en vuelo. **`cargaYaDebitada` es una consulta y no un `ON CONFLICT`** porque
  `credit_transactions` es append-only: la idempotencia por lote la daba el índice único de
  `document_ingest_batches`, y un débito por documento necesita la suya. ⚠️ **La columna `unit`
  de `credit_rules` no la lee nadie** (`estimateRequiredCredits` solo mira `ruleType` y
  `creditsPerUnit`): es declarativa, y en producción está en NULL para las cuatro reglas.
- **Una moneda que NO soportamos no se renombra a la nuestra** (2026-08-30). `asCurrency`
  devolvía la moneda base ante cualquier cosa que no fuera GTQ o USD, así que una fila que decía
  `EUR` se guardaba como `GTQ`: **€100 entraban como Q100**, subestimando ~8,4 veces, y
  `staging-rules` no podía desmentirlo porque el payload ya decía una moneda válida. La
  confusión era tratar igual la celda VACÍA (la hoja no dice la moneda: usar la de la empresa es
  correcto y sigue igual) y la celda que SÍ dice una moneda que no manejamos (la hoja lo afirma
  y nosotros lo ignorábamos). Ahora la segunda se conserva para que la fila se marque
  `invalid_currency` y vaya a revisión — visible en vez de silenciosamente mal. Hacen falta las
  DOS listas: los alias de lo que sí manejamos (`Q`, `Qtz`, `US$`, `dólares`) porque sin ellos
  ensanchar la guarda marcaría filas que hoy pasan, y las monedas reales que no manejamos para
  poder distinguirlas de un rótulo ilegible, que sigue cayendo a la base.
- ⚠️ **HUECO CONOCIDO: no hay forma de representar una DEVOLUCIÓN** (verificado 2026-08-30, no
  arreglado). Los cuatro tipos son `revenue`/`cogs`/`opex`/`other` y ninguno significa "reduce
  el ingreso"; `assemblePayload` además hace `Math.abs()` del monto, y esa regla es CORRECTA
  para lo que la motivó (muchos exportes escriben los egresos en negativo — el libro de
  `08_Boutique_Elegance` lo dice en su subtítulo: *"Egresos en negativo"*, y sus 139 negativos
  son todos compras y gastos). Pero una nota de crédito o una devolución de venta es un
  negativo con SIGNIFICADO, no una convención de formato: hoy se absolutiza y se suma como
  ingreso, o sea que el error es **2× el monto devuelto**. No se tocó porque **ninguno de los
  once archivos reales disponibles trae una sola fila así** y arreglarlo bien exige un tipo
  nuevo que toca el ledger, los rollups y el dashboard — riesgo alto para un caso sin
  ocurrencia. Cuando aparezca, el arreglo es un tipo `refund`, no relajar el `Math.abs()`.
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
  - **El breakpoint del grid de KPIs**: pasábamos a 5 columnas en `2xl` (1536px). Una MacBook de 14" da **1512px** — 24px por debajo del corte —, así que en la máquina donde se demuestra el producto caían a 3 columnas, los KPIs ocupaban dos filas y la gráfica de tendencia quedaba abajo del pliegue. **Corregido dos veces:** el primer intento copió el `lg` (1024px) del prototipo y estaba MAL — el dashboard descuenta sidebar, paddings y el rail de 348px, así que a 1080px una tarjeta queda en **39px útiles (tres caracteres)** y `GTQ 389.9K` son diez. El prototipo puede usar `lg` porque escribe `Q1.18M` (6 chars); nosotros escribimos `GTQ` completo, que es regla del producto. Los cortes actuales salen de MEDIR dónde la cifra entra: `kpi4` (1300px) y `kpi5` (1480px), definidos en `screens` de `tailwind.config.ts` con la tabla de medición al lado.
  - **El dato de apoyo de la tarjeta**: cifra exacta, frase de ayuda y "vs mes anterior" iban en `body` (14px/1.5) donde el prototipo usa 10px con interlínea apretada. Tres líneas de 21px contra 13px, más el chip del delta en su propia fila, dejaban la tarjeta en ~258px contra ~152px. Tokens nuevos: `micro` (10px) y `delta` (12px).
  - **El título de pantalla**: el panel seguía en `text-h1 font-normal` (27px/400) — más grande Y más delgado que el prototipo (24px/600), o sea que ocupaba más y mandaba menos. `pagetitle` (20px/600) se había creado cinco semanas antes en CU-868kt8bg0 **con la nota escrita de que el dashboard ya no usa `h1`**, y el dashboard siguió usándolo. Por eso ahora hay test (`styles/densidad-prototipo.test.ts`) y no solo un comentario: el comentario ya falló una vez.
  Pendiente y NO hecho acá: el rail derecho del panel. En el prototipo trae tres consejos con contenido real (una cobranza vencida con monto y días de mora, una oportunidad de venta con su valor, el net burn del mes); en el nuestro es un texto que explica lo que el producto *haría* más dos alertas del mismo tipo repetidas. Eso no es escala, es contenido, y probablemente pesa más en la sensación de "no se asimilan" que cualquier píxel.
- **La cifra de KPI se ENCOGE antes que cortarse** (CU-868ku6r48, 2026-08-19). `truncate` sobre una cifra financiera no recorta: **miente**. Si lo que se pierde es la `K`, `GTQ 389.9K` se lee como trescientos ochenta y nueve quetzales donde hay trescientos ochenta y nueve mil — un factor de mil, en la cifra principal del dashboard, sin que nada falle. Ahora `escalaDeCifra()` baja a `kpi-sm` (20px) o `kpi-xs` (17px) según el largo de la cadena, y `truncate` queda como última red. **El tamaño se decide por longitud de cadena y NO midiendo el DOM**: la tarjeta se pinta en el servidor, así que un `ResizeObserver` haría que la primera pintura saliera con el tamaño equivocado y saltara al hidratar, en cada carga.
- **El Consejo Financiero Diario lleva severidad y acción** (CU-868ku6r48). El esquema de la herramienta `emit_insights` (backend, `lib/anthropic.ts`) pide `severity` (`critical`/`warning`/`info`, obligatoria) y `action` (opcional). **Va en el esquema y no en el prompt** porque el prompt de insights es editable por un super_admin desde `platform_settings`: una regla escrita en el template no llega a producción. La severidad se pinta con `Badge` —chip con fondo y borde— y no como texto de color: acá no hay flecha que sirva de canal redundante, a diferencia del delta de un KPI. `info` va en `neutral` a propósito, para no gastar la señal que `critical` necesita. Los consejos se ordenan por urgencia antes de pintarse: el backend no garantiza orden y el panel vive en el rail derecho, donde lo que queda abajo no se lee. Un consejo sin `severity` (los guardados antes de este ticket en el ledger `insight_requests`) se trata como `info` — no se puede afirmar que algo urge cuando nadie lo evaluó.
- **Regla de los DOS VERDES** (CU-868knx0vh, aprobada por Jose 2026-08-11). El color sigue sin decorar, pero ahora hay dos verdes con roles que no se pisan. **Verde de marca** (salvia `#A0AF9A` + gradiente, token `brand`): dice "esto es Macha" — Insight Point, acentos, pantallas de vitrina, cabecera de reportes. **Verde funcional** (`#16A34A`, token `success`): dice "este dato va bien" — deltas, chips, series. Rojo funcional para lo negativo. **Prueba de fuego: si el color dice "va bien o mal" es funcional; si dice "esto es Macha" es salvia.** Nunca el mismo tono para ambos, y el salvia **nunca sobre un dato**. El color de estado nunca aparece SOLO. **Matizado en CU-868ktknbq (2026-08-19): texto+fondo+borde era UNA forma de cumplirlo, no la única.** Lo que la regla protege es que el estado no dependa únicamente del color —quien no distingue verde de rojo tiene que poder leerlo igual—, así que basta cualquier canal redundante. El delta de una tarjeta de KPI lo cumple con la FLECHA (↗ ↘) y por eso ya va sin caja (`DeltaBadge presentation="inline"`): el chip se llevaba una fila entera de cada tarjeta. **El chip sigue siendo el default y sigue siendo obligatorio donde no hay flecha** — un rótulo de estado a secas (`key-alerts-card`) no tiene otro canal que el fondo y el borde. Hay test que lo fija (`styles/densidad-prototipo.test.ts`): si alguien quita la flecha del delta en línea, falla.
- **Tipografía: SF Pro Display AUTO-HOSPEDADA** (`next/font/local`, cuatro pesos desde `app/fonts/`, 1.3 MB). Inter salió del bundle; la SF del sistema queda de respaldo en `--font-ui-stack` por si el `.otf` no carga. ⚠️ **Riesgo de licencia asumido por el dueño:** SF Pro es de Apple y su licencia **no cubre servirla desde web** — solo diseñar con ella para plataformas Apple. Está documentado en `lib/fonts.ts`; revertir es editar ese archivo y borrar `app/fonts/`, porque ningún componente conoce el nombre de la fuente.
- **Regla mono, revisada**: las **cifras salieron** de `JetBrains Mono` (era el cambio de mayor impacto visual del rediseño: la monoespaciada hacía leer el producto como herramienta de desarrollador). Los números van en la tipografía de interfaz con `tabular-nums` — que es lo que de verdad los alinea en tablas, un ajuste independiente de la familia. `font-mono` **sigue siendo obligatorio** para eyebrows y labels en mayúscula con tracking, que son rasgo de identidad y no dato.
  **Acotada, no deshecha (CU-868ktknbq, 2026-08-19):** lo que hacía leer el producto como herramienta de desarrollador era la CIFRA GRANDE en monoespaciada, y esa sigue en la tipografía de interfaz — hay test que lo fija. Pero el prototipo (fuente de verdad visual) sí usa mono en el **dato de apoyo pequeño**: la cifra exacta bajo el KPI y el delta, a 10-12px. Ahí el ancho fijo ayuda a leer una columna de dígitos en vez de disfrazar el producto, así que vuelve. La frase de ayuda (`hint`) es prosa y no lo lleva.
- **Formatting is locale-aware and centralized**: use `formatMoney/formatDate/formatPct` helpers over `Intl.*` (`es-GT`/`en-US`); always show explicit currency code (GTQ/USD). Never format inline.
- **Component split**: Tremor Raw for charts + KPI/indicator cards; shadcn/ui for everything else. Don't use two libs for the same role. **Known deviation**: F1 actually installed `@tremor/react` (the classic npm package), not real Tremor Raw (copy-paste source) — decided 2026-07-27 to avoid a mid-epic chart-library migration; restyled on our own tokens. Revisit only if `@tremor/react` becomes a real blocker.
- Auth UI is WorkOS AuthKit (hosted); the app verifies session, it does not implement login/password/email-verification.
- **El logo de los CORREOS se sirve por URL pública desde `public/brand/`; el de los PDF va embebido** (2026-08-20, reporte de Jose "el logo se rompe"). Mismo asset, dos transportes, y elegir mal no falla nada visible de este lado: se rompe dentro de un correo ya enviado, que nadie del equipo vuelve a abrir. Los dos hechos que lo deciden son al revés de lo que suena:
  - **Gmail SÍ carga imágenes remotas** (desde 2013, por su proxy `googleusercontent.com`, sin pedir permiso) y **NO renderiza `data:` URIs**: los descarta. CU-868ku6jn1 había incrustado el PNG en base64 razonando lo contrario —"Gmail y Outlook bloquean imágenes remotas"—, o sea que eligió el único formato que Gmail no soporta para esquivar un bloqueo que dejó de existir hace más de una década. El `alt` en la captura de Jose era la degradación, no el resultado.
  - **`brand` está FUERA del matcher de `middleware.ts`**, y esa es la mitad que no se ve venir: dentro, `authkitProxy` responde **307 hacia WorkOS** a quien pida el archivo (verificado en producción con `/icon.svg`), y un cliente de correo no sigue redirecciones para cargar una imagen. Que el archivo exista en `public/` no alcanza. Fuera del matcher, no en `unauthenticatedPaths`: lo segundo lo deja pasar por el middleware para que decida no exigir sesión; lo primero es que el middleware ni corra.
  - **La URL es INMUTABLE POR CONTRATO**: un correo de hace seis meses sigue pidiendo esa ruta. El archivo no se reemplaza en su sitio — un logo nuevo va como **nombre nuevo**. Por eso se cachea `immutable` un año (el proxy de Google revalidaría mucho más seguido de lo que el archivo cambia) y por eso el cacheo alcanza a `brand/` y no a `public/` entero, donde el favicon y los íconos sí se reemplazan.
  - **En el PDF el binario tiene que viajar adentro** (`embedPng` en `report-render.ts`): un reporte se abre fuera de la app y a veces sin red. Ahí una URL sería el error simétrico.
  - Y `width`/`height` van como **atributos HTML**, no solo en el estilo: Outlook usa el motor de Word e ignora el CSS de tamaño en imágenes, así que sin ellos reserva el tamaño natural del PNG (170×200) y el logo sale gigante. Se derivan del aspecto real (0,85), con test — un ancho inventado deforma el isotipo.
  - Los tres hechos están fijados en `next.config.test.ts` y `email-shell.test.ts`, comprobados contra la regresión. El test viejo decía *"el logo va incrustado como data URI"* y pasaba porque el código hacía lo que el código hacía: **probaba la implementación, no lo que el cliente de correo necesita.**
- **Los ALTOS de gráfica salen de una medición y viven en `CHART_HEIGHT`** (`components/charts/chart-primitives.tsx`, 2026-08-20). Jose reportó que las gráficas de Analítica se ven "mucho más grandes" que el prototipo. El reporte apuntaba al RELLENO del área; medido, el relleno **ya coincidía**: con `showGradient`, `@tremor/react` emite `stopOpacity 0.4 → 0` (offset 5 %→95 %) contra `0.35 → 0` del prototipo. El `stopOpacity: 0.3` que se ve en ese `dist` es la rama SIN gradiente, que no es la nuestra. Tampoco era el trazo: Tremor usa `strokeWidth: 2` contra `2.5` del prototipo, o sea que ya era más fina. **Lo que sí era: el alto** — `h-80` (320px) por defecto y `alto="h-96"` (384px) en los tabs, contra 240px. El prototipo no tiene NINGUNA área por encima de 260px; sus 320 son para barras. Dos cosas más que quedan fijadas: el eje Y del panel de tendencia va OCULTO (el prototipo usa `<YAxis hide>` y la cifra del período ya da la magnitud exacta; las tablas accesibles equivalentes traen la serie completa), y ninguna pantalla escribe un alto a mano — de ahí salió el `h-96`, un string suelto lejos de donde se decide el estilo de los charts. El dashboard y CxC/CxP **no** se tocaron porque se midieron y ya coincidían (`h-64` y `h-[260px]`).
- **El acento de marca del Dashboard va junto al título, nunca de fondo** (2026-08-20). `InsightPoint` en modo `figure` al lado del saludo, tamaño `sm` y sin ícono. La prohibición está escrita en el propio componente y no es preferencia: el salvia **nunca** detrás de una tabla o una gráfica, porque compite con el verde funcional de series y deltas y hace dudar de si el color pertenece al dato. El Dashboard es KPIs y gráficas de punta a punta, así que `ambient` está descartado ahí.
- **"Filas marcadas" explica la COLA, no solo la fila** (2026-08-20). El reporte de Jose ("no se logra entender qué tiene que hacer el equipo de MACHA ahí") no era falta de explicación por fila: `instructions` ya se pintaba a nivel de pantalla, pero dice *"Revisa ESTA fila"* estando arriba de veinte. Ahora arriba va el contexto (de dónde salen y que **no entran a la contabilidad del cliente** hasta que alguien las resuelva: mientras estén en la lista, faltan en su dashboard) y la instrucción se movió a su tarjeta. Se agregó lo que el ticket no pedía y hacía falta: **qué NO le toca a staff** — desde el acuerdo con Semi el cliente contesta sus propios conceptos, así que un operador podía pasar la tarde poniendo categorías que el dueño iba a contestar mejor, y pisándolo. Y el marco va ANTES de los cortes por estado, porque el caso que más lo necesitaba era la cola **vacía**: "Sin filas pendientes" era indistinguible de una pantalla rota.
- **La plantilla que descarga el cliente tiene DOS fuentes, y el fallback es el diseño** (2026-08-20). `GET /industry-templates/download` sirve el archivo CURADO que staff subió (`industry_starter_templates`, migración `0035`) y **sigue generando uno al vuelo si no hay** — también si la clave está en la base pero el objeto de S3 no se puede leer. Por eso la URL siempre devuelve un archivo y el frontend no tiene ni un condicional: el criterio "el onboarding no rompe ni muestra un enlace roto" se cumple por construcción. La tabla es aparte de `industry_template_versions` a propósito (esa le enseña a la IA a leer el Excel que el cliente YA tiene; esto es un archivo PARA el cliente) y **no lleva RLS**: es catálogo de plataforma, y ponérsela haría que se leyera vacía desde el camino del cliente. Lo único que la protege es el guard de `/admin/*`, así que ahí el guard no es defensa en profundidad. `normalizeIndustry` va en LOS DOS lados: `companies.industry` es texto libre y sin eso "Retail" y "retail" serían dos industrias.
- **"Parámetros de negocio" no estaba vacía por construcción: `platform_settings` tiene 0 filas en producción** (verificado 2026-08-20). Y el bug no era "falta correr el seed": `getPlatformSetting` recibe un fallback y lo usa, así que producción **tiene cinco parámetros en efecto** y el panel mostraba cero — un panel de configuración que ocultaba la configuración vigente. Ahora lista las claves que el producto tiene con su valor efectivo y su `source` (`stored`/`default`), **sin escribir nada**: la fila se crea al editar. `SETTINGS_DEFAULTS` tiene que dar el mismo valor que el fallback de cada llamador y hay test, porque si se separan el panel muestra un número y el sistema usa otro. ⚠️ **`credit_to_tokens_ratio` no la consume nadie**: está declarada como "configurable desde el panel" y ningún `getPlatformSetting` la lee; un operador la edita, ve que se guardó, y nada cambia. Se deja listada (ocultarla esconde el problema) con un test que falla si alguien la conecta, para que borre la advertencia.
- **EL LOGIN FUNCIONA por `macha.finance` — la URI ya está registrada en WorkOS** (re-verificado 2026-08-24). Versiones anteriores de este archivo abrían con *"⚠️ EL LOGIN ESTÁ ROTO POR TODOS LOS DOMINIOS"* y **eso ya no es cierto**: alguien agregó `https://macha.finance/callback` a los *Redirects* de WorkOS entre el 21 y el 24 de agosto. Medido siguiendo el flujo entero: `https://macha.finance/login` responde 307 al `authorize` de WorkOS con `redirect_uri=https%3A%2F%2Fmacha.finance%2Fcallback`, y ese `authorize` **aterriza en la pantalla de AuthKit** (`scientific-procession-52.authkit.app`, 200 con "Sign in"), no en el `Invalid redirect` que devolvía antes. `/callback` sin código degrada bien: 307 a `/?auth_error=1`.
  **CERRADO EL 2026-08-26: el middleware fuerza el dominio canónico** (`destinoCanonico` en `lib/auth/canonical-origin.ts`, PR #212). Versiones anteriores de esta nota terminaban en *"mientras no haya un dominio canónico con los demás redirigiendo a él, este bug vuelve por la puerta de al lado. Ese es el arreglo de verdad"*. Ese arreglo ya está hecho, y hacía falta: Jose reportó el síntoma TRES veces —la última *"cuando le doy logout, me vuelve a mandar al URL de Vercel"*— porque el `redirect_uri` sigue siendo un valor fijo y la sesión solo puede existir en un host. En producción, todo host que no sea el canónico se redirige **antes** de que corra `authkitProxy`. Verificado contra producción: `macha-finance.vercel.app/dashboard` → **307** a `macha.finance/dashboard`, conservando ruta y query; `macha.finance` no se redirige a sí mismo (sin bucle).
  - **Va ANTES del proxy y ese orden es el punto.** Si AuthKit corre primero, a quien llega sin sesión ya le respondió 307 hacia WorkOS con el `redirect_uri` del canónico, y la sesión queda escrita en un host distinto del que el usuario mira. Redirigir después no arregla nada.
  - **Arreglar `signOut` para que mande una URL absoluta (CU #211) era necesario y NO suficiente**, y por eso el reporte volvió: quién obedece ese `return_to` lo decide WorkOS contra su lista de redirects, que es de **dashboard y no de API**. Si la URL no está ahí, cae a SU default —el de Vercel— y el síntoma reaparece con la causa movida de sitio. Ningún cambio en el repo puede controlar ese paso; el redirect del middleware lo vuelve irrelevante.
  - **Solo con `VERCEL_ENV === 'production'`** (comprobado: la variable SÍ llega al runtime edge). Sin esa guarda, cada preview de PR se redirigiría a producción y **la revisión por PR dejaría de existir** — el revisor abre el enlace de Vercel, aterriza en el producto en vivo, ve el código viejo y cree que vio el nuevo. Es peor que el bug que esto arregla, y hay test.
  - **307 y no 308**: el destino sale de una variable que YA se movió una vez y dejó el login caído un día entero; un 308 queda cacheado sin vencimiento en la máquina de cada usuario y seguiría mandando al dominio viejo. Verificado en producción: `cache-control: max-age=0, must-revalidate`.
  - **El destino se DERIVA de `NEXT_PUBLIC_WORKOS_REDIRECT_URI`**, no de una constante: escribir el dominio en un segundo lugar es exactamente cómo el login y el logout terminaron apuntando a hosts distintos.
  - ⚠️ **El destino se arma asignando `pathname`, NUNCA resolviendo la ruta contra la base.** `new URL('//evil.com/x', 'https://macha.finance')` devuelve `https://evil.com/x` —dos barras es relativo al PROTOCOLO— y la ruta viene de la petición: mi primera versión era un **redirector abierto**, con el producto despachando al usuario a otro sitio con su propio 307. Lo atrapó el test antes de salir. (Vercel además normaliza `//path` a `/path` con un 308 relativo antes de que el middleware corra, o sea que hay dos capas; no confiar en la segunda.)
  - **No alcanza a lo que el `matcher` excluye** (`brand/`, `icon.svg`, `landing/`, `api/public/`, `monitoring`): ahí el middleware ni corre. Es correcto —son estáticos y endpoints públicos que se sirven igual por cualquier host— y verificado que siguen dando 200 sin redirect.
  **Lo que sí conviene conservar de aquella nota, porque no se arregló y vuelve solo:** el `redirect_uri` es un **valor fijo** (`NEXT_PUBLIC_WORKOS_REDIRECT_URI` en Vercel), no derivado del host — medido en su momento: `macha.finance/login` y `macha-finance.vercel.app/login` mandaban los dos el mismo. Así que con **CUATRO dominios** apuntando al mismo proyecto (`macha.finance`, `macha-finance.vercel.app`, `macha-finance-macha6.vercel.app`, `macha-finance-git-main-macha6.vercel.app`), **el login solo puede funcionar entrando por UNO**, y hoy ese uno es `macha.finance`. Entrar por cualquiera de los otros tres sigue fallando. Registrar los cuatro en WorkOS **no alcanza** —el valor que se manda es uno solo—, así que mientras no haya un dominio canónico con los demás redirigiendo a él, este bug vuelve por la puerta de al lado. Ese es el arreglo de verdad.
  **Y la lección de orden, que costó un día de login caído:** los redirect URIs de WorkOS **son de dashboard, no de API** — no se pueden tocar por código. Si alguna vez hay que cambiar el dominio, se registra la URI nueva en WorkOS **antes** de mover la variable en Vercel. Al revés (que fue lo que pasó el 21/08) WorkOS corta ANTES de mostrar la pantalla de login, o sea que nadie llega ni a escribir su correo — peor que fallar después de autenticar. Y `NEXT_PUBLIC_*` se cocina en el build: cambiar la variable exige redeploy **sin cache de build**.
- **El favicon vive en `app/icon.svg` y ya se rompió de DOS formas distintas** (2026-08-21). Las dos dejaban la pestaña con el ícono genérico y las dos se veían bien en el repo: (a) **el middleware lo interceptaba** — el matcher excluía `favicon.ico`, que este proyecto no tiene, y no `icon.svg`, que sí; `GET /icon.svg` devolvía 307 hacia WorkOS. (b) **el SVG era XML inválido**: su comentario de cabecera contenía dos guiones seguidos (al citar tokens CSS por su nombre real, `var(--foreground)` y `--ink`), y XML lo prohíbe dentro de un comentario. **Por eso los tokens se nombran ahí sin prefijo** (`ink`, `brand`) y hay test de la regla. La lección que generaliza: verificar `200` + `content-type` + contenido NO prueba que un asset sirva — hay que comprobar que se pueda PARSEAR, y eso solo se ve con un parser de verdad contra producción. El contenido es el isotipo monocromo (`#171717` / `#f2f2f2` por `prefers-color-scheme`), que es la decisión de CU-868ktkwqn aplicada al último lugar que le faltaba.
- **`macha.finance` es la LANDING; `/` ya no enruta a nadie** (pedido de Keneth 2026-08-21). Hasta ese día `/` hacía dos trabajos: portada Y enrutador de post-login (a `/dashboard`, a la invitación pendiente, a registrar, o a la salida de emergencia con el backend caído). Todo eso se movió a `app/continue/page.tsx` y **`/callback` apunta ahí** — dejarlo en `/` habría hecho que un usuario autenticara bien y aterrizara en la página de marketing sin ninguna señal, que es indistinguible de que el login no funcionó. Tres cosas se ganan con la separación, y la segunda es la que importa: la landing **no lee la sesión ni llama al backend** (hay test que lo fija), así que una caída de Railway ya no se lleva la portada del producto — antes consultaba `/me/memberships`; Next la puede prerenderizar; y un cliente con sesión que escribe `macha.finance` ve la landing, que es lo que se pidió. El botón de "Iniciar sesión" está detrás de `NEXT_PUBLIC_SHOW_LOGIN_CTA` (`lib/landing-flags.ts`), **default oculto** y se exige el string `'true'` exacto: si alguien despliega un entorno nuevo y se olvida de la variable, la landing sale sin invitar a entrar a un producto que todavía no está abierto. Esconder el botón **no cierra la puerta**: `/login` sigue vivo y entrar es escribirlo. El aviso de `?auth_error=1` sí trae el enlace a `/login` aunque el flag esté apagado — quien acaba de fallar al entrar ya sabe que la puerta existe.
- **Los 16 frames del Figma de la landing NO son copias: cada uno tiene un item distinto abierto en los acordeones** (2026-08-21, corrección de Keneth a una conclusión mía equivocada). Yo los leí como "16 importaciones del mismo HTML con ruido entre iteraciones" y construí la página con UNO, porque comparados por contenido las diferencias eran de 1 a 24 líneas sobre 244. Esas líneas eran el contenido del item expandido. Medido después: **190 textos comunes a los 16 frames y 47 que varían**, y los 47 están en `capacidades`, `faq` y `asesor`. O sea que los frames no eran redundancia sino la **especificación completa de los dos acordeones**, y usar uno solo dejaba cada uno con un item lleno y el resto vacío. La lección que generaliza: en un archivo de Figma con muchos frames casi iguales, lo que varía **es** el contenido interactivo, y descartarlo como ruido borra justo la parte que no se puede inferir. Las 14 secciones están en `components/landing/`; solo las dos con acordeón llevan `'use client'`.
- **La landing no inventa precios ni interacciones que no existen** (mismo día). Los tres planes **no llevan cifra** porque el diseño no la trae — dice "definimos el alcance en la demo" — y un número que nadie aprobó en la pantalla donde el cliente decide si puede pagarlo es lo peor que se puede poner ahí; los tres van al MISMO `mailto`, porque la conversión de esa sección es la conversación. Las pestañas del mockup de producto ("Costos", "Flujo de caja") se pintan `aria-hidden` como etiquetas: solo existe la captura de "Ventas del mes", y una pestaña que no cambia nada al apretarla promete algo que no está. Y el footer nombra "Aviso de privacidad", "Términos" y "Política de datos" **como texto, no como enlaces** (hay test): un `href="#"` en un producto que maneja la contabilidad de terceros le enseña algo al que lo aprieta buscando qué hacemos con sus datos, y no es lo que queremos que aprenda. El único camino de conversión es `contact@machafinance.com` con el asunto **codificado** — sin `encodeURIComponent` el `mailto` se corta en el primer espacio en varios clientes y llega un correo con asunto vacío.
- **La landing son BANDAS a todo el ancho, y sus tonos son tokens y no los hex del Figma** (segundo reporte de Keneth sobre la landing, 2026-08-21: *"hay partes que tienen color negro y así, falta bastante trabajo"*). La primera versión metía las catorce secciones en UN contenedor de 1170px separadas por `gap`. Medido sobre el frame, los fondos de sección **alternan** entre el lienzo y `#F9F9F9`, y una —el asesor con IA— va sobre `#191919` de borde a borde; sin bandas, el ritmo que separa las secciones no existía y la única sección que cambia de tinta tampoco. No era una sección suelta: era la estructura de la página plana. La tabla completa (y, alto y fondo de las 14) vive en `components/landing/banda.tsx`, que es lo único que conoce colores: **la sección no sabe de qué color es su fondo**, y por eso la banda oscura es exactamente la misma pieza que las claras. `sutil` es `bg-muted` (`--fill` = `#f7f7f7`, dos partes en 255 del medido) y la oscura es la clase `.inverse` que ya existía — **escribir el hex del diseño es el error que parece fidelidad**: no tiene contraparte en tema oscuro, así que quien tenga el sistema en oscuro vería un bloque blanco cegador donde va una banda gris. Y el full-bleed **no usa `100vw`**: incluye la barra de scroll, o sea ~15px de desbordamiento horizontal en Windows y Linux.
- **Los 16 frames especifican TRES estados, no dos: capacidades, FAQ y las pestañas del asesor** (misma fecha, corrección sobre mi propia corrección). Ya había aprendido que los frames no son copias sino un item distinto abierto en cada uno; lo que no vi es que el tercer conjunto que varía son los chips del asesor con IA. Lo había construido estático —las tres preguntas con su respuesta a la vez, razonando por escrito que "un carrusel esconde dos tercios del argumento"— cuando el diseño es tres chips y UN panel. La lección que generaliza y que ya me costó dos vueltas: **en ese archivo, lo que varía entre frames ES la especificación de una interacción**, así que cada conjunto de textos que cambia hay que buscarlo hasta el final antes de decidir cómo se comporta la sección. Va como `role="tablist"` **con flechas de teclado**: media implementación es peor que ninguna, porque el lector de pantalla anuncia "pestaña 1 de 3" —le indica al usuario que use las flechas— y entonces tienen que responder.
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
