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
  0-bis. **SIETE FALLOS QUE SOLO APARECEN CON UN ARCHIVO MAL HECHO** (2026-08-30). Los pasos de
     abajo se escribieron contra archivos reales de clientes, que son desprolijos pero están
     *bien escritos*. Generando libros **mal hechos** a propósito —typos en los encabezados,
     columnas corridas, montos escritos a mano, meses mal escritos, fechas imposibles— y
     midiendo la CIFRA DEL DASHBOARD contra la verdad de campo del archivo, saltaron siete
     defectos que ningún test por etapa veía. Viven en `lib/hostiles/` (el generador y el doble
     de modelo), `lib/hostiles-e2e.test.ts` y `tests/integration/hostiles-al-dashboard.test.ts`;
     `bun run hostiles:generar` los escribe a disco con un `VERDAD.md` al lado.
     **El doble de modelo es IGNORANTE a propósito**: clasifica muy bien lo que se le da y no
     sabe nada de lo que no se le dio, así que una hoja que el pipeline debería haber filtrado
     produce cifras plausibles y equivocadas —igual que el modelo de verdad con la cartera de
     KapePrueba—. Un doble omnisciente taparía justo lo que hay que medir.
     1. **`sheet-header` devolvía la PRIMERA fila que cubre la tabla**, y `cubreLaTabla` acepta
        desde la MITAD del ancho del cuerpo. Un pie de página de 3 celdas (`2026 · 8 · "Hoja 1
        de 1"`) le ganaba al encabezado de 6. No pierde la hoja: **desplaza el mapa y los datos
        salen de las columnas de al lado**. 32 ventas en cero. Ahora desempata por `puntaje`,
        que ya estaba escrito y medía exactamente eso (título con números 0,40 · encabezado
        0,75 · fila de datos 0,60). El umbral flojo NO se sube: rompería el encabezado con
        columnas sin nombre, que es legítimo.
     2. **La coherencia de día declaraba "resumen por período" a los gastos recurrentes.** La
        justificación escrita —"un movimiento ocurre el día que ocurre, así que sus días
        varían"— es cierta de una venta y **falsa del gasto fijo de cualquier PYME**: el
        alquiler se paga el 1, la planilla el 30, la cuota el 15. La guarda golpeaba a los
        movimientos más previsibles que existen, y con más fuerza en el día 1 y el último del
        mes, que son los dos que `finDeMes` y `dias.size === 1` declaran marcador. El veto por
        CONTRAPARTE fue el primer intento y era demasiado angosto (el propio
        `pareceLibroDeMovimientos` lo advierte: *"la hoja de gastos de una PYME no nombra
        proveedor y lo es"*). Lo que generaliza: **un resumen por período tiene el período y
        CIFRAS, nada más** — las dos hojas reales que motivaron la señal no traen una sola
        columna de texto. El piso de 5 caracteres deja fuera la columna de MONEDA, que si no
        cumpliría el veto siempre y apagaría la señal entera.
     3. **Las firmas de catálogo se buscaban por vocabulario EXACTO**, así que `Contactoo ·
        Telefonoo · Condicionees` las apagaba enteras y la cartera de clientes se iba al
        modelo — el bug de KapePrueba por otra puerta, y la puerta la abre cualquiera que
        escriba mal un encabezado. Ahora toleran UNA edición y solo desde 6 caracteres; las
        `prohibidas` siguen exactas, porque un typo no puede VETAR una firma que sí se cumple.
        `cumpleFirma` vive una sola vez: `classifySheet` y `firmaDeCatalogo` tienen que dar el
        mismo veredicto o una hoja de existencias se declara catálogo y después no se sabe
        cuál, con lo que se descarta en vez de irse a inventario.
     4. **Un mes con typo apagaba el despivotado entero** (`Enrero`, `Febrro`, `Abrl`,
        `Agosot`): la matriz no se detectaba como reporte, no se despivotaba, se quedaba sin
        columna de fecha y desaparecía. Q 48.240 medidos, con el síntoma de siempre — utilidad
        neta igual a utilidad bruta. ⚠️ **La tolerancia es CONTEXTUAL, no por etiqueta suelta**,
        y el test existente encontró el falso positivo antes de que saliera: `Marca` está a una
        edición de `march` y una concesionaria tiene esa columna, igual que `Marco` de `marzo`,
        `Julia` de `julio` y `Género` de `enero`. Hacen falta **≥1 mes exacto y ≥2
        casi-coincidencias EN EL MISMO ENCABEZADO**. Y la tabla de meses pasó a vivir **una sola
        vez** (`mesPorNombre` en `sheet-shape`, consumida por `mesDeEncabezado`): este archivo
        ya advertía que las dos copias tenían que coincidir, y mantenerlas a mano ES el modo de
        fallo que la advertencia describe.
     5. **`asDate` tenía TRES copias de "esta fecha existe" y cada una traía la guarda que a
        las otras les faltaba.** El camino de barras validaba el desbordamiento y no el año
        (`15/07/1823` entraba tal cual); el ISO validaba el año y no el desbordamiento, porque
        delegaba en `new Date` (`2026-02-31` salía como **2026-03-03**); el de mes en palabras
        tenía las dos, duplicadas. Las dos fallas **MUEVEN la fila de período** sin que nada
        falle, que es el daño más caro de esta casa. Ahora las dos reglas viven solo en
        `fechaValida`. Lo destapó la MUTACIÓN: desactivar la guarda en una copia no ponía en
        rojo el test que cubre a la otra, o sea que el test medía código distinto del que yo
        creía estar tocando.
     6. **`preciounitario` salió de la firma `existencias`.** Es la columna de una LÍNEA DE
        DOCUMENTO, no de una lista de stock: `LineasOC` (`No. Orden · Producto · Cantidad ·
        Precio Unitario · Total`) cumplía la firma entera y se iba a INVENTARIO. No duplicaba
        dinero, pero metía 36 artículos inventados **y la sacaba de `vivas`** — o sea que el
        dedup cabecera/detalle, que existe exactamente para ese par, nunca llegaba a verla. Un
        filtro que se equivoca temprano apaga a todos los de abajo. La premisa que falla es la
        que justifica la firma ("un movimiento siempre tiene fecha por fila"): una LÍNEA no la
        tiene, la hereda de su cabecera. Los dos casos reales que motivaron la firma no
        necesitan esa palabra (ferretería: `Costo Unitario` + `Precio Lista`; boutique:
        `Costo Unitario` + `Precio Venta`).
     7. ⚠️ **HUECO CONOCIDO, medido y NO cerrado: un inventario serializado que ninguna otra
        hoja referencia entra como GASTO.** `analizarEsquema` solo reconoce una tabla de
        entidades si otra hoja la referencia; cuando la facturación no nombra el VIN, nada la
        apunta y los vehículos en stock llegan al modelo. Medido: **Q 1.864.500** de egreso que
        nadie desembolsó. Es CarsGT (Q 16 M en producción) por la puerta que la señal
        estructural no cubre. **El arreglo natural se implementó y se REVIRTIÓ**: dejar de
        exigir la referencia (clave única + no referencia a nadie + nadie la referencia) tiene
        un contraejemplo exacto en un test que ya existía —`Ventas` (`ID Venta · Monto`) y
        `Gastos` (`ID Gasto · Monto`) cumplen las tres y pasarían a inventario—, y el veto por
        contraparte no salva a una hoja de mostrador que no nombra al cliente. Perder la
        contabilidad de un cliente en silencio es peor que mostrarle un gasto de más, que al
        menos se ve. Cuando aparezca un archivo real así, el camino es una firma de
        EXISTENCIAS SERIALIZADAS (clave única + atributos del artículo + costo + **sin** columna
        de cantidad), no aflojar el esquema del libro. Está fijado con su cifra en
        `hostiles-e2e.test.ts` para que no se vuelva invisible.
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
     ⚠️ **Hace falta MASA y una LLAVE ESPECÍFICA para afirmar duplicación** (2026-08-30). Un
     libro con `Ventas` (una venta de Q 1.500), `Compras` (Q 700) y `Gastos` (un alquiler de
     Q 1.500) descartaba los GASTOS como duplicado de las VENTAS: comparten la forma y el total,
     por azar. Dos defensas independientes, con test de cada una por separado —o una tapa el
     agujero de la otra y nadie se entera de que se rompió—: (a) los encabezados **genéricos**
     (`fecha`, `monto`, `moneda`, `concepto`…) ya no cuentan como llave compartida, porque los
     tiene cualquier hoja de movimientos y la condición se cumplía entre dos hojas cualesquiera
     del libro; lo que sí es evidencia es un `IDOC` o un `Documento`. (b) Un piso de **8 filas**:
     con tres, dos totales iguales se explican por azar tan bien como por duplicación, y los
     casos que este módulo existe para atrapar son grandes por naturaleza (60 y 220 filas en el
     archivo que lo motivó).
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
  ⚠️ **Y el revert TAMBIÉN se lleva los artículos de inventario que solo esa carga sostenía**
  (2026-08-30). Reporte de Keneth: *"subí 4 archivos, les di revert, el dashboard se limpia
  pero el inventario sigue mostrando lo del primer excel"*. El síntoma señala la causa: el
  importador trata la cantidad como un CONTEO, así que **la primera carga CREA el artículo** (con
  su nombre, SKU y costo) y las siguientes solo ajustan la cantidad del mismo SKU — los
  artículos en pantalla son, por construcción, los de la primera. `compensarInventario` dejaba
  la existencia en cero y el listado filtra por `deleted_at` y **nunca por cantidad**, así que
  el artículo seguía ahí. Medido contra Postgres real: 1 artículo donde debía haber 0.
  **El criterio NO es "la creó esta carga"**, y ahí está todo: un artículo que la carga 1 creó y
  que alguien ajustó A MANO después no puede desaparecer porque se revierta la carga 1 — ese
  conteo es trabajo de una persona. Se da de baja solo si la existencia quedó en cero **Y todos
  sus movimientos vienen de cargas revertidas o canceladas**; un movimiento manual tiene
  `document_id` NULL y su sola presencia lo salva, que es la garantía que `recordMovement` ya
  prometía en su comentario y que hasta ese día nada hacía cumplir.
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
- **Una factura RECIBIDA produce su COSTO además de la cuenta por pagar** (2026-08-30). Es el
  fallo simétrico del de la factura emitida y estuvo abierto porque el razonamiento se detuvo a
  mitad de camino: la nota decía *"una `bill` NO produce ingreso: sería registrar como ingreso
  lo que la empresa debe"* —cierto y vigente— pero faltaba decir que **sí produce un costo**. Se
  confundió "no es ingreso" con "no es nada", y `rollups.ts` suma `cogs` y `opex` solo de
  `transactions`, así que el gasto **desaparecía del estado de resultados**. Afecta a toda
  empresa que registre las facturas de sus proveedores en una hoja de cuentas por pagar, o sea a
  cualquiera que lleve contabilidad por devengo. **El tipo lo decide el modelo, no un default**:
  una factura de proveedor puede ser mercadería (`cogs`) o alquiler (`opex`), y elegir `opex`
  por defecto inflaría el margen de cualquier comercio que compre inventario a crédito; sin
  tipo no se deriva nada y la fila va a revisión. Y **el prompt ahora define la frontera
  cogs/opex** (punto 15), que antes quedaba al criterio del modelo: eso hacía que el margen
  bruto —cifra de portada— saliera distinto entre dos corridas del mismo archivo.
- ⚠️ **CONTESTAR NO DESMARCA UNA FILA QUE LA RESPUESTA NO ARREGLA** (`quedaLimpiaAlContestar`,
  2026-09-01). El peor fallo posible de esta pantalla, medido en producción con
  `libro-el-infierno`: **el cliente contestó 18 conceptos, los vio vaciarse, y no aterrizó ni
  uno.** Sin error en ninguna parte. La cadena entera:
  1. Una venta en **EUR** —moneda que no manejamos, conservada a propósito para que la fila se
     marque— llegó además con confianza baja.
  2. `evaluateFlagReason` devuelve `low_confidence` **antes** de mirar fecha, monto y moneda,
     así que el problema REAL de la fila quedó escondido detrás.
  3. `esArreglablePorCategoria` miró ese motivo, dijo que sí, y la fila se ofreció como
     concepto.
  4. El cliente la contestó y el `POST` le limpió la marca.
  5. Al promover, `resolveFxRate` no encontró tasa para EUR y **lanzó**. La promoción es UNA
     transacción, así que se cayó la de las otras 17 filas resueltas.
  Es la **promoción parcial (migración 0020) rota a nivel de FILA**: una sola fila impromovible
  dejando fuera a todas las demás, que es exactamente el problema que esa migración existe para
  eliminar.
  **La pregunta correcta no es "¿el motivo es de categoría?" sino "¿con una respuesta PERFECTA
  esta fila quedaría limpia?"**, y se contesta con la MISMA `evaluateFlagReason` que decide todo
  lo demás (confianza en 1, tipo y categoría puestos) en vez de con una segunda lista de motivos
  que se separaría de la primera. Vive una sola vez y tiene **tres consumidores**: el GET no
  pregunta lo que no se arregla, el POST no limpia una marca que sobrevive a la respuesta, y el
  correo no avisa por lo que el cliente no puede resolver.
- **EL PORTÓN: NADA ENTRA AL DASHBOARD SIN QUE EL CLIENTE LO CONFIRME** (migración `0042`,
  2026-09-01, decisión de Keneth con la medición delante). La carga ya no se promueve sola: el
  dueño ve PRIMERO el resumen POR HOJA con el dinero que cada una aporta, y su contabilidad
  entra cuando dice que está bien.
  - **Por qué por HOJA y no por fila.** Los siete fallos de ingesta de esta semana **no fueron
    filas dudosas**: fueron decisiones sobre hojas, con alta confianza y equivocadas — una
    cartera de clientes leída como ingresos (Q 13.362), un consolidado propio contado dos veces
    (+945), un presupuesto entrando como dinero real, cobros devengando otra vez (+52 %).
    Ninguna la habría atrapado una revisión fila por fila; todas se ven de un vistazo en una
    lista de hojas con su monto al lado.
  - ⚠️ **REINTRODUCE la forma que dejó 0 filas en producción** antes de la 0020 (medido: 0
    contra 3.195 en staging), y se asumió a propósito. La diferencia es de quién es el trabajo:
    allá lo hacía staff de Macha y era fila por fila; acá lo hace el dueño y son tres o cuatro
    decisiones sobre su archivo. **La mitigación no es aflojar el portón sino hacerlo imposible
    de no ver**: correo con deep link, banner, y la carga listada como "esperando tu
    confirmación".
  - **Vive en los DOS llamadores, no en `promoteDocument`.** Hay exactamente dos caminos a la
    promoción —el worker al terminar la ingesta y `encolarPromocionDeLoResuelto`, la única que
    encola `document.promote`— y los dos lo afirman. Dentro de `promoteDocument` no: esa
    función es el MECANISMO de promover y la usa también el camino que ABRE el portón, así que
    meterle la condición de producto la volvería imposible de llamar desde ahí.
  - **Lo que hubo que corregir con él**, y no se veía venir: el CUADRE se quedaba sin ledger y
    gritaba `nada_aterrizo` en toda carga nueva (ahora compara contra lo que **va a
    publicarse**, con la expansión de esa misma fuente); el CORREO decía *"el resto de tus datos
    ya está en tu dashboard"*, que con el portón es falso — la misma mentira que el banner
    sostuvo tres semanas tras la promoción parcial; el aviso se dispara **aunque no haya un solo
    concepto**, porque una carga que el modelo entendió perfecto no tiene filas marcadas y se
    quedaría invisible para siempre; y una carga que **no produjo ninguna fila** no pide
    confirmación.
  - **Se puede publicar sin contestar los conceptos**: sus filas quedan retenidas y el resto
    entra. Obligar a contestarlas convertiría el portón en un trámite bloqueante, que es la
    forma exacta que la 0020 vino a eliminar.
  - **Excluir una hoja RECHAZA sus filas** por el mismo camino que usa staff, y no las borra:
    qué decidió el dueño sobre su propio archivo tiene que poder leerse. **Volver a INCLUIR una
    hoja descartada no se puede** — exige reprocesar con el modelo; lo que sí se hace es
    decirlo con su motivo y su dinero, que es lo que permite desmentirnos.
- ⚠️ **LA RESPUESTA DEL CLIENTE NO PISA UNA FILA DERIVADA** (`ES_DERIVADA`, 2026-09-01). Medido
  probando el portón de punta a punta: el concepto "Aceite 1 L" agrupaba DOS filas —la venta de
  GTQ 1.890 y **su costo derivado de GTQ 1.160**, que comparten `product`—. El dueño contestó
  "es un ingreso", que es CIERTO de su venta, y con eso convirtió el costo en ingreso:
  **+1.160 de ingreso y −1.160 de costo**. El total del archivo **cuadraba al centavo**, así que
  el error era invisible; lo que se movía era el MARGEN BRUTO, que es cifra de portada.
  El pipeline crea filas que no están en el archivo —el costo de una venta con costo en la
  línea, el ingreso devengado de una factura, el costo de una cuenta por pagar— y su tipo es una
  REGLA CONTABLE, no una lectura del texto. Ahora se marcan y la respuesta del cliente les
  limpia la duda (su dinero tiene que aterrizar) **respetándoles el tipo**.
  **Agrupar por producto es correcto y no se toca**: es lo que hace contestable la pantalla
  cuando la hoja no trae descripción (977 de 4.686 filas marcadas solo tienen `product`).
  ⚠️ **El test que vale es el de INTEGRACIÓN**: el unitario probaba una reimplementación local de
  "aplicar la respuesta" y la mutación NO lo ponía en rojo — medía código distinto del que yo
  creía estar tocando.
- **CONTESTAR UNA CUENTA POR PAGAR PRODUCE SU COSTO** (`lib/derivacion-de-costo.ts`,
  2026-09-01). La regla del 2026-08-30 (*"una factura RECIBIDA produce su COSTO además de la
  cuenta por pagar"*) estaba **a medias**: `construirFilas` la deriva cuando el MODELO da el
  tipo, y cuando no lo da la fila llega marcada y la contesta el CLIENTE — pero ese camino
  solo actualizaba el payload, limpiaba el flag y promovía. La fila iba a `bills` y
  `rollups.ts` suma `cogs`/`opex` solo de `transactions`.
  Medido en producción con `12-la-ceiba.xlsx`: **12 órdenes de compra por GTQ 56.391,00, el
  82 % del costo real del libro**. El cliente contestó, las filas marcadas bajaron de 15 a 3,
  el panel dijo que estaba listo, y el estado de resultados no se movió; el rubro que escribió
  no aparecía en ninguna categoría y el margen bruto salía en 55,4 %. Es el bug de U3TECH del
  lado del cliente, y **peor, porque le dijimos que lo había resuelto**: la pantalla existe
  para que su contabilidad quede exacta, así que una respuesta que no mueve la cifra es la
  única forma de fallo que no puede tener.
  - **La derivación vive UNA sola vez** porque son DOS productores de la misma fila del ledger
    (la ingesta y la respuesta del cliente); si divergen, el mismo archivo da cifras distintas
    según quién clasificó la fila. Misma lección que `esArreglablePorCategoria` y `cumpleFirma`.
  - ⚠️ **Hace falta una MARCA (`SIN_DERIVAR`) o el arreglo se come su propia guarda.** Una
    `bill` cuya derivación la ingesta suprimió a propósito (`compraYaRegistradaEnOtraHoja`: el
    libro ya registra esa compra en otra hoja) llega a revisión SIN tipo, **indistinguible**
    desde el handler de una que el modelo no supo clasificar — el cliente contestaría y el
    costo entraría por segunda vez. `yaTieneSuCosto` mira el payload ANTES de aplicar la
    respuesta, que es el único momento en que se puede separar "no supo" de "ya está contado".
  - La fila derivada **hereda `sheet_name`** (sin eso el cuadre por hoja de la 0039 reportaría
    descuadre en las dos) y entra ya aprobada, para que la promueva el mismo camino que todo lo
    demás. La fecha es la de **emisión**, nunca la de vencimiento.
- **Un COBRO no es una venta nueva** (2026-08-30). `ventaYaRegistradaEnOtraHoja` protegía
  únicamente a las filas `invoice`, y ese era el hueco: una hoja de cobros tiene fecha, cliente
  y monto, así que lo natural es que el modelo la clasifique `transaction/revenue` — y ahí nada
  la frenaba. Medido: `Facturacion` (Q 238.387) + `Cobros` apuntando a esas mismas facturas
  (Q 124.432) daba **52 % más ingreso** que la facturación real. ⚠️ **La guarda va ANTES del
  primer `out.push`**: el primer intento la puso después de emitir la fila, así que solo evitaba
  el desdoble del costo y el ingreso duplicado seguía entrando — una guarda que corre después de
  emitir no guarda nada. Hay test que mide el TOTAL emitido y no la cantidad de filas,
  justamente para que esa distinción no se pierda.
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
- **EL CUADRE: se compara lo LEÍDO contra lo ATERRIZADO** (`lib/cuadre.ts`, 2026-08-30).
  `medirFilas` (`lib/reconciliation.ts`) ya escribía cuánto dinero traía cada hoja y **nadie lo
  comparaba nunca contra el ledger**: la medición existía, el resultado existía, y no había nada
  que notara cuando no se parecen. Este módulo cierra ese lazo, y es lo único del pipeline que
  detecta un fallo en **un archivo que nadie vio nunca** — los tests cubren archivos que ya
  vimos, y ahí estuvo el hueco durante siete reportes. Contra los defectos reales de la ingesta
  ninguno cae dentro de una banda razonable: todos son ×0, ×2 o ×1,52.
  - ⚠️ **La cota superior se CALCULA, no se elige.** Un número fijo es imposible: una expansión
    legítima llega a 3× (una factura con costo en la línea produce la factura, su ingreso
    devengado y el costo) mientras el duplicado que hay que atrapar es ×2. La salida es que la
    expansión no es un misterio — el pipeline SABE cuántas filas de ledger produjo por fila del
    archivo, porque él mismo las creó (`filasEnElLedger / filasMedidas`) — y la cota sale de ahí
    con un margen del 15 %. La pregunta pasa de "¿cuánto es demasiado?" a "¿lo aterrizado se
    parece a lo que este pipeline dijo que iba a producir?", que sí tiene respuesta.
  - **NO BLOQUEA, y es decisión.** Un falso positivo que frene la promoción deja al cliente sin
    su contabilidad por un chequeo que se equivocó. Lo que cambia es que un descuadre queda
    ESCRITO: cuando alguien reporte "esto no cuadra", la respuesta ya está en los logs en vez de
    haber que reconstruirla a mano, que es literalmente lo que pasó las siete veces.
  - ⚠️ **Va DESPUÉS de `promoteDocument`.** El primer intento lo puso antes, con el ledger
    todavía vacío, y reportaba `nada_aterrizo` en TODAS las cargas — un detector que grita
    siempre es uno que nadie mira. Lo atrapó el test de integración; el orden de dos bloques del
    worker no se ve desde un test unitario.
  - **Tres tablas, no una**: `transactions` + `invoices` + `bills`. Olvidar una haría que toda
    carga de facturas pareciera un descuadre por exceso.
  - **`en_revision` es un veredicto propio y distinto de `falta`**, porque piden acciones
    opuestas: lo primero necesita que alguien mire la cola (el trabajo ya tiene dueño), lo
    segundo que alguien mire el pipeline (hay plata que nadie sabe dónde quedó). En el mismo
    cajón, el caro se pierde entre decenas del rutinario. Un renglón de TOTAL declarado `skip`
    se DESCUENTA de lo leído; una fila marcada por `invalid_date` **no**, porque esa sí es plata
    que el cliente esperaba ver.
  - **Por moneda y nunca sumado**: un dólar contado como quetzal subestima ~7,7 veces, así que
    un total mezclado escondería justo el tipo de error que esto busca.
- **EL CUADRE ES POR HOJA, Y SU VEREDICTO SE GUARDA** (2026-08-31, migraciones `0039` y `0040`).
  Tres cambios que atacan la misma raíz: **el pipeline se equivoca en silencio y nadie se
  entera hasta que un cliente lo reporta.**
  - **Cada descarte declara SU DINERO** (`lib/sheet-money.ts`). Los cinco puntos donde el
    worker descarta una hoja registraban `filas: rows.length` y **ninguno el monto**: el
    sistema podía decir "descarté 220 filas" y no "descarté Q 2.707.318". Cada bug de ingesta
    de estos meses fue una exclusión o una inclusión equivocada, y el dinero es lo único que
    las vuelve evidentes de un vistazo — para el dueño, que es quien puede desmentirlas, y para
    nosotros, que así podemos ordenar por riesgo. Medido sobre los diez archivos reales:
    `LineasOrdenCompra[duplica] Q 510.691` en la ferretería, `ResumenGerencial[reporte]
    Q 100.256` en el hotel. ⚠️ Es una ESTIMACIÓN por encabezados y magnitudes —esa hoja nunca
    tuvo mapa del modelo— y **no alimenta el ledger**: explica y ranquea, nunca contabiliza.
  - **El cuadre se hace POR HOJA** (`evaluarCuadrePorHoja`), no solo por documento. Sumando el
    libro entero, **una hoja que aterriza el DOBLE y otra que aterriza CERO cuadran perfecto**:
    los dos errores se cancelan y la razón da 1,00 exacto. Esa es la forma de KapePrueba (dos
    hojas de detalle perdidas + una cartera inventando ingresos) y la de CarsGT (cobros
    devengando de nuevo + stock como costo). Se compara contra `staging_rows` y no contra el
    ledger porque `transactions` guarda `document_id` y no `sheet_name` — de ahí la migración
    `0039` — y porque staging conserva la moneda ORIGINAL, sin el ruido de la conversión. La
    expansión se calcula **por hoja**: una de facturación expande 2× y una de gastos 1×, y el
    promedio del libro daría una banda demasiado ancha para una y demasiado angosta para la
    otra.
  - **El veredicto se PERSISTE** (`documents.reconciliation`, migración `0040`) y hay cola en
    `/admin/reconciliation`. El encabezado de `cuadre.ts` afirmaba que "un descuadre queda
    ESCRITO en el resumen de la carga" y **era falso**: iba a `console.warn`, y verificado
    contra producción el 2026-08-31, el veredicto de dos cargas recién reportadas por el
    cliente **ya no existía** — Railway conserva una ventana corta, no agrega y no alerta. Es
    el mismo error que `read-summary.ts` documenta haber corregido para los datos de lectura
    ("hoy va a console.info y rota con los logs de Railway"): la lección estaba aprendida en un
    módulo y sin aplicar en el que más la necesitaba.
- ⚠️ **EL ×2 DEL PORTÓN: UN RENGLÓN DE TOTAL SE CONTABA COMO UN MOVIMIENTO** (reporte de
  Keneth con un archivo real de cliente, `Jewelry_Store_Template11`, 2026-09-03). *"En el primer
  Excel me dice que son 140 pero en la web me salía 280."* Las **cinco** hojas de dinero
  mostraban ×2 EXACTO en el resumen del portón, reproducido al centavo: facturación 280.090,00
  sobre 140.045,00; cartera 256.300,00 sobre 128.150,00; gastos 54.123,86 sobre 27.061,93. Un
  total es POR DEFINICIÓN la suma de las filas de arriba, así que medirlo reporta el doble — y
  **que sea ×2 exacto en las cinco es la firma del bug**: una expansión legítima tocaría las
  facturas, no los gastos operativos.
  - ⚠️ **El daño es específico del PORTÓN y por eso es grave.** Esa pantalla (0042) existe para
    que el dueño pueda DESMENTIRNOS antes de publicar; enseñarle el doble de su facturación lo
    deja eligiendo entre aprobar una cifra falsa o no aprobar su contabilidad correcta, y la
    única herramienta que tiene para controlarnos es la que miente. El ledger no se toca: el
    renglón no trae fecha, así que `staging-rules` lo marca por `invalid_date`.
  - **Dos fallos encadenados, y hacían falta los dos.** (1) `medirFilas` no consultaba nada:
    `sheet-classifier` y `sheet-duplication` ya excluían el renglón de total de SUS mediciones
    y ésta era la tercera; ahora las tres consumen `filaEsRenglonDeTotal`. (2) **`TOTALS`, el
    plural INGLÉS, no matcheaba** — el regex tenía `totales` (el plural español) y el `\b` hacía
    que `total` seguido de `s` no cerrara palabra, así que el rótulo más común de una plantilla
    en inglés era invisible para los tres filtros.
  - ⚠️ **La guarda mira la PRIMERA CELDA NO VACÍA, no cualquier celda.** El rótulo no está en la
    columna 0 —está alineado a la derecha, pegado a la cifra— pero buscarlo en toda la fila es
    más laxo sin cubrir un caso que ocurra: un movimiento cuya descripción diga "Pago total a
    proveedor" es plata del cliente, y esconderla es peor que el bug original — **el doble se
    ve, lo que falta no**. Hay test de ese caso.
- ⚠️ **Y EL CONSOLIDADO AL FINAL DE LA MISMA HOJA, QUE ES LA OTRA PUERTA DEL MISMO ×2**
  (`inicioDelResumenAlFinal` + `medirHoja`, mismo día). El mismo archivo termina `Operating
  Expenses` con un bloque `EXPENSES BY CATEGORY` de once categorías que suma exactamente lo
  mismo que su detalle. No llegó a duplicar por casualidad —sus cifras caen en la columna 1 y la
  de monto es la 3— pero basta alinearlo bajo la columna de montos, que es lo natural al
  escribirlo: medido, 54.123,86 sobre 27.061,93.
  - **La señal es que el resumen REPITE LAS CATEGORÍAS del detalle**, no su forma: un bloque
    angosto al final puede ser cualquier cosa, pero un consolidado reusa por definición los
    valores que agrupa. Es la cuarta guarda del despivotado ("sus conceptos no son ya las
    categorías de otra hoja") aplicada DENTRO de una hoja. Tres condiciones juntas: bloque
    angosto, **≥3 filas** (con una o dos, coincidir pasa por azar) y **≥70 % de las etiquetas en
    UNA MISMA columna** del cuerpo (un consolidado agrupa por un campo, no por varios).
  - ⚠️ **Se cuentan solo las filas del bloque que APORTAN UNA CIFRA.** Con el título de sección,
    el encabezado nuevo y el renglón de total, la coincidencia real —cuatro de cuatro— caía a
    4/7 = 57 % y el bloque no se reconocía. La corrección NO era bajar el umbral, que es lo que
    parecía, sino preguntar sobre las filas correctas: bajarlo dejaría entrar bloques que sí son
    datos nuevos.
  - **`medirHoja` existe porque `medirFilas` mide un LOTE** y no puede ver más allá de él; un
    consolidado solo se reconoce mirando la hoja entera.
  - ⚠️ **DOS DE LAS TRES MUTACIONES NO SE DETECTABAN, y la lección vale más que el arreglo.**
    Mutar `medirHoja` para que no recorte dejaba la suite en VERDE: los tests cubrían la
    DETECCIÓN y ninguno la CONEXIÓN con la medición, que es la mitad que le llega al cliente
    (mismo error que `mapaDelLote` y `aplicarEntidadForzada`). Y el off-by-one del índice
    tampoco —`inicio` se calcula sobre la hoja CON encabezado y `filas` no lo tiene—, porque en
    el primer test la fila que se colaba era el renglón de total, **que ya se excluye por su
    cuenta**: el error quedaba TAPADO por la otra guarda. Hace falta un consolidado que empiece
    directo con una categoría, que es como lo escribe quien no le pone título.
- ⚠️ **UNA HOJA QUE REPITE LOS HECHOS DE OTRA, FILA POR FILA** (`detectarHechosRepetidos`,
  2026-09-03). Encontrado **probando de punta a punta en producción**, no por un reporte: el
  `Accounts Receivable` de `Jewelry_Store_Template11` son las MISMAS ventas de `Sales Orders`,
  facturadas — `INV-6001` es la factura de `SO-2001`, mismo cliente y mismo monto. Medido:
  **154 de 154** pares (cliente, monto) coinciden, y el dashboard mostró **268.195 sobre
  140.045 reales, un +91 %**: cada venta contada dos veces, una como venta y otra como factura
  devengando su ingreso.
  - **No lo atrapaba NINGUNA de las dos guardas que existían, y por motivos distintos.**
    `ventaYaRegistradaEnOtraHoja` se apoya en el ESQUEMA del libro, que necesita una columna de
    la cartera cuyos valores existan en las ventas — esa plantilla lleva `Invoice #` y
    `Cust. ID`, **nunca `Order #`**, así que no hay referencia que detectar ni la hay en
    principio. Y `detectarDetalleDuplicado` compara TOTALES, que no empatan (140.045 contra
    128.150, porque no todas las ventas se facturaron); bajar ese umbral es justo lo que la
    nota de ese módulo advierte que no se haga.
  - **La señal es la coincidencia FILA POR FILA del par (contraparte, monto)**, no el total. Un
    agregado se deja engañar; que 154 filas coincidan en quién y cuánto no pasa por azar.
  - ⚠️ **Es la regla más peligrosa del módulo y sus guardas son duras a propósito**: un falso
    positivo no muestra una cifra de más —que se ve— sino que **BORRA el ingreso de un cliente**,
    que no se ve. ≥95 % de cobertura (no una mayoría: un solape parcial entre dos hojas
    legítimas es normal), ≥8 filas, con **MULTIPLICIDAD** (tres facturas de (CU-001, 440) no las
    cubre una sola venta: dos son dinero que nadie registró), las dos hojas con contraparte
    legible, y **si cada una contiene a la otra esto NO decide** — son la misma tabla dos veces
    y eso lo resuelve el dedup por totales, que sabe distinguir una cabecera de un resumen.
  - ⚠️ **NO descarta la hoja.** La factura se crea igual —el cliente necesita su cartera en Por
    cobrar— y lo único que no ocurre es el devengo por segunda vez. Descartarla dejaría Por
    cobrar en cero, que es el bug de U3TECH. Es la misma bandera de la hoja de cobros.
  - Verificado sobre los 15 libros del corpus: detecta los tres casos correctos (dos hojas de
    cobros que ya se suprimían por la vía estructural, más el nuevo) y **cero falsos positivos**
    en los otros doce.
  - ⚠️ **TRES COSAS QUE DESTAPÓ ESCRIBIR EL TEST, y valen más que el arreglo.** (1) El e2e de
    integración era imprescindible: mutar el worker para que ignore la segunda vía dejaba la
    suite ENTERA en verde, porque ningún test pasaba por el worker con esa forma de libro — la
    lección de `mapaDelLote` otra vez. (2) El doble de `classifySheetRows` tiene que RECIBIR y
    REENVIAR la bandera a `construirFilas`, o la cartera devenga igual **con el log diciendo
    "No devenga de nuevo"**. (3) El primer fixture usaba 24 montos TODOS DISTINTOS y
    `analizarEsquema` tomó la columna de dinero como CLAVE FORÁNEA (`Invoice Amount` → `Total`,
    cobertura 1,00), declarando `Sales Orders` tabla de entidades: se iba entera al inventario.
    Una joyería vende el mismo anillo varias veces; **un fixture con montos únicos no
    representa ningún archivo**.
- ⚠️ **LA CANTIDAD DEL INVENTARIO SALÍA DE «STOCK STATUS»** (2026-09-03, misma sesión de pruebas
  de punta a punta). La hoja se desviaba BIEN al inventario —el log decía *"forzada a INVENTARIO
  por el dueño (43 filas)"*— y terminaba en **"0 altas, 43 omitidas"**, con el portón diciéndole
  al dueño *"Actualizó tu inventario"*. Su hoja es `SKU | Item Name | Location | Qty On Hand |
  Reorder Point | Unit Cost | Inventory Value | Stock Status`: `stock` estaba en las pistas de
  cantidad y `buscarColumna` acepta prefijos, así que **`Stock Status`** —cuyos valores son
  "OK", "Low", "Out"— le ganaba a `Qty On Hand`, que no figuraba. De paso `name` daba null: el
  cliente habría visto el SKU como nombre de cada artículo.
  - Se arregla por dos lados y **el segundo es el que generaliza**: se agrega el vocabulario en
    inglés, y además **se verifica que la columna elegida traiga NÚMEROS** (`mayoriaNumerica`).
    Ninguna lista de palabras cubre todos los rótulos que a alguien se le ocurran; que la
    columna tenga números sí es verificable, y descarta de un golpe la clase entera de "eligió
    la columna de estado / de nombre / de fecha". Va en LOS DOS pases de `buscarColumna`: el
    primero busca coincidencia exacta, así que una columna literalmente llamada `Stock` llena
    de texto la elegiría sin dudar.
  - Se exige MAYORÍA (60 %) y no perfección —un archivo real trae huecos y algún `#N/A`— y sin
    filas de muestra la guarda no aplica: sin evidencia no se descarta nada.
- **EL CUADRE DEJÓ DE GRITAR SOBRE LO CORRECTO** (2026-09-01). Dos falsos positivos medidos
  sobre libros cuyas TRES cifras salieron exactas contra su verdad de campo — y un detector que
  se equivoca en lo correcto enseña a ignorarlo, que es lo único que este mecanismo no puede
  permitirse: es lo único que ve un fallo en un archivo que nadie miró nunca.
  - **Veredicto `no_se_registra`.** Una hoja de COBROS no aterriza nada **a propósito** (su
    ingreso ya lo devengó la factura a la que apunta), y su forma es idéntica a la del fallo más
    caro: cero aterrizado habiendo dinero en el archivo. Sin distinguirlas es un falso positivo
    GARANTIZADO en todo libro que lleve cobros, que son la mayoría — medido: `Cobros
    nada_aterrizo USD 9.300,00` en una carga perfecta. El worker registra qué hojas suprimió en
    el mismo punto donde ya consulta el esquema (`marcarSiSuprimida`), para que la bandera no
    pueda separarse del veredicto que la produce. **Se REETIQUETA, no se omite**: el veredicto
    se persiste y quien abra la cola tiene que poder leer qué pasó con esa hoja. ⚠️ `sobra` NO
    se reetiqueta — que una hoja suprimida aterrice dinero significa que la supresión falló, o
    sea el doble conteo que la regla existe para evitar.
  - **El veredicto que manda es el de POR HOJA, cuando lo hay.** El cuadre del documento usa una
    expansión ESCALAR (filas de ledger sobre filas medidas, en todo el libro) que no le sirve a
    ninguna hoja: una de facturación expande 2× y una de gastos 1×, así que el promedio deja la
    banda demasiado ancha para una y demasiado angosta para la otra. Medido: `sobra` en USD
    (1,19× contra 0,79× de expansión calculada) mientras las cinco hojas cuadraban una por una.
    Es el mismo engaño del total que motivó el cuadre por hoja, del otro lado. El total queda
    como RESPALDO de lo que la vista por hoja no cubre (filas sin `sheet_name`, o sea cargas
    anteriores a la 0039).
- **EL LIBRO "EL INFIERNO" Y LOS TRES BUGS QUE ENCONTRÓ** (`lib/hostiles/libro-el-infierno.ts`,
  2026-09-01). Diecisiete hojas en un cuaderno y solo SIETE producen movimientos: copia exacta
  de una hoja, consolidado propio de cuatro filas, cartera de clientes con los encabezados mal
  escritos, cabecera y detalle, matriz de gastos con los meses con typo, un estado de resultados
  con la MISMA forma, cobros de facturas ya devengadas, presupuesto por trimestres, cinco
  formatos de fecha en la misma columna, montos escritos a mano, una moneda que no manejamos, un
  renglón de TOTAL y un pie de página que compite con el encabezado. Trae además 30 filas que el
  CLIENTE contesta, con su dinero en la verdad de campo: si contestar no mueve la cifra, el test
  se pone rojo.
  1. ⚠️ **`Ventas` se descartaba ENTERA.** Ocho movimientos buenos en cuatro formatos de fecha,
     más una fecha imposible, un TOTAL y un pie de página, daban **9/12 = 75 %** contra el 80 %
     que exige `noPuedeProducirMovimientos`. Las dos suciedades más comunes de un Excel hecho a
     mano restaban cobertura y se llevaban la hoja por delante **antes del modelo**, sin dejar
     una sola fila que alguien pudiera revisar. El resto del pipeline ya las tolera —el modelo
     declara `skip` sobre un TOTAL, `sheet-header` sabe que un pie de página no es encabezado—;
     faltaba que este filtro no las contara como evidencia EN CONTRA. Solo salen del
     DENOMINADOR: descartarlas o marcarlas sigue siendo cosa de `staging-rules`.
  2. ⚠️ **El renglón de TOTAL DUPLICABA la columna en `sheet-duplication`.** Un TOTAL es por
     definición la suma de las filas de arriba, así que incluirlo hace que una hoja con TOTAL no
     pueda empatar NUNCA con su consolidado ni con su detalle — y ese módulo entero se apoya en
     que dos hojas sumen lo mismo. Medido: `Ventas` (GTQ 13.196) sumaba 26.612.
  3. ⚠️ **Un PRESUPUESTO se despivotaba como dinero real.** `Ventas proyectadas · Compras
     proyectadas · Gastos proyectados` por trimestre entraban como 12 movimientos: pasaban las
     cinco guardas sin despeinarse, porque no llevan vocabulario de agregado, sus conceptos no
     aparecen en ninguna hoja de detalle (no ocurrieron) y no hay identidad aritmética entre
     ellos. Sexta guarda, con vocabulario CERRADO como el de los agregados — **sin `plan`**
     (`Planilla` lo contiene y es el gasto más común de una PYME) ni `meta`.
  `esRenglonDeTotal` se CONSUME de `sheet-unpivot` en los dos lugares nuevos: si dos módulos
  juzgaran distinto qué es un total, la misma fila se excluiría de un lado y no del otro.
  **Medido: el fuzzer pasó de 295 a 300/300 libros exactos** —los arreglos del TOTAL cerraron
  también los cinco huecos que quedaban— y el veredicto es IDÉNTICO en las 55 hojas de los diez
  archivos reales de clientes.
- **FUZZER DE LIBROS: 300 permutaciones con verdad de campo, en `bun test`**
  (`lib/hostiles/fuzz.ts` + `lib/hostiles-fuzz.test.ts`, 2026-08-31). Los libros escritos a
  mano cubren lo que YA conocemos; los fallos de esta ingesta viven en la **combinación** de
  doce filtros por cada forma de libro, y ese espacio no se escribe a mano. Se permutan formato
  de fecha (serial · `DD/MM` · ISO · mes en palabras · `MM/DD`), líneas de título, cantidad de
  filas, egresos en negativo, costo en la línea, renglón de TOTAL, consolidado propio,
  cabecera+detalle, catálogo, inventario, matriz de gastos, facturación+cobros y hoja basura.
  Semilla explícita y nunca `Math.random()`: un fallo se reproduce con `generarLibro(N)`.
  **La primera corrida dio 120 libros rotos de 200 y destapó tres defectos preexistentes**, los
  tres pérdidas o duplicaciones silenciosas que ningún cliente había reportado:
  1. **Una fecha escrita como TEXTO se usaba de clave foránea** (`sheet-relations.comoClave`).
     `ES_SERIAL_DE_FECHA` cubría el caso numérico, pero medio archivo real trae la fecha como
     `15/07/2026` o `15 de julio de 2026` — lo que sale de cualquier libro que pasó por un CSV.
     Dos hojas del mismo período se "referenciaban" por su fecha, el esquema creía que una
     repetía un hecho ya contado y `ventaYaRegistradaEnOtraHoja` **suprimía la hoja entera**. Es
     el bug de U3TECH (cero ingresos con la facturación bien leída) por otra puerta. Un solo
     cambio: 80 → 162 libros exactos.
  2. **La misma ceguera en el dedup** (`sheet-duplication`). `aNumero` es lenient a propósito
     —tiene que leer `Q 1,234.50`— así que convierte `01/04/2026` en **1042026**, muy por
     encima del rango de un serial. Dos hojas del mismo período sumaban ~14 M cada una y
     quedaban dentro del 1 %: una se descartaba con todo su dinero (−Q 63.871 medidos).
  3. **Columnas de IDENTIFICADOR contadas como dinero**, en el mismo dedup: `FAC-1000` valía
     mil, `Cliente 3` valía tres. Con cinco columnas espurias por hoja, un empate del 1 % por
     azar deja de ser raro y el precio del empate es descartar una hoja entera. Ahora una celda
     es cifra solo si, quitados los símbolos de moneda, no queda más que dígitos y separadores.
  Estado: **300/300 exactos** (los tres arreglos de `libro-el-infierno` cerraron los cinco que quedaban). El hueco que quedaba —un consolidado propio de menos de 6 meses
  volvía a contar su ingreso— **se cerró el 2026-09-01**, y la forma de cerrarlo es lo que vale.
  Se midió primero en PRODUCCIÓN: un libro con `Ventas` (4 movimientos, GTQ 945) y su
  `Resumen_Mensual` (4 filas, GTQ 945) dejó el dashboard con **+945,00 sobre una verdad de campo
  de 34.209,00** (+2,8 %), con el costo y los gastos exactos. Los dos arreglos OBVIOS tienen
  contraejemplo y se descartaron: bajar el piso del dedup ante un empate AL CENTAVO pone en rojo
  un test que ya existe (`Ventas` 1000+2000+3000 y `Gastos` 1500+2500+2000 suman 6000 las dos,
  por azar), y exigir además que solo UNA se baste sola tampoco separa ese par —la hoja de
  gastos de una PYME no nombra proveedor y es de movimientos igual—. Lo que sí lo cierra es
  **COMBINAR DOS SEÑALES DÉBILES**: empate al centavo **más** forma de consolidado por período
  (`pareceResumenPorPeriodo`, la señal 6-bis de `sheet-shape` extraída para vivir una sola vez,
  con su mínimo bajado solo para este llamador). Un marcador de período no elige su día —lo pone
  la fórmula— y un movimiento sí. ⚠️ **Y el consolidado está EXENTO de compartir encabezado**:
  un resumen no comparte columnas con su detalle (`Mes · Total Ventas` contra `Fecha · Cliente ·
  Producto · Monto`), así que exigir la llave apagaba la regla en el único caso para el que se
  escribió. Verificado: veredicto IDÉNTICO hoja por hoja en los diez archivos reales de
  clientes, y las dos mitades comprobadas por mutación.
- **`MIN_VALORES_PARA_RELACION` bajó de 8 a 4, y a 2 si los valores son CÓDIGOS**
  (`sheet-relations`, 2026-08-31). De ese número dependen dos reglas sobre el dinero —"la
  factura no devenga si su venta ya está registrada" y "un cobro no es una venta nueva"—: sin
  referencia detectada, ninguna llega a evaluarse. Con 8, una hoja de **seis cobros** contra
  facturas ya devengadas volvía a registrar su ingreso: **+44,9 % medido**. Seis recibos es la
  contabilidad normal de una PYME chica, así que la guarda estaba apagada para quien menos
  puede desmentirla y fallaba **hacia arriba**, la dirección que parece una buena noticia.
  El piso de 4 está MEDIDO (con 3 se pone en rojo el test propio del módulo contra el falso
  positivo), y por debajo solo se baja cuando los valores compartidos **parecen códigos de
  documento** (mezclan letras y dígitos, o son números de 4+ cifras): `FAC-1007` no es una
  etiqueta y coincidir en dos hojas del mismo libro no le pasa por azar. Verificado contra los
  **diez archivos reales de clientes**: veredicto idéntico hoja por hoja.
- **`costounitario` salió de la firma `existencias`** (`sheet-classifier`, 2026-08-31). Mismo
  caso que cerró `preciounitario` el 2026-08-30, por la otra puerta y más común: una línea de
  ORDEN DE COMPRA no lleva precio de venta, lleva costo. `LineasOC` cumplía la firma entera,
  metía 48 artículos inventados en el inventario del cliente **y la sacaba de `vivas`**, así que
  el dedup cabecera/detalle —que existe exactamente para ese par— nunca llegaba a verla. Los dos
  inventarios de mostrador que motivaron la firma siguen entrando por `Precio Lista` /
  `Precio Venta`, que es lo que de verdad los separa de una compra.
- **EL AVISO PROACTIVO: "tu archivo necesita tu atención"** (CU-868kyur58, 2026-09-01,
  migración `0041`). Una carga que quedaba con conceptos sin clasificar solo se descubría si el
  cliente volvía a entrar por su cuenta; sus filas esperaban una respuesta que nadie le pidió.
  - ⚠️ **NO se dispara donde el ticket decía, y ahí está el punto.** El ticket pedía hacerlo "en
    el mismo punto donde se escribe `status: 'review'`" — escrito ahí, **el aviso se pierde el
    caso más común**: con promoción parcial (migración `0020`) una carga con filas retenidas
    termina en `promoted` con `flagged_count > 0`, y solo llega a `review` la que no promovió
    NADA. Un cliente con 6 conceptos pendientes sobre 1.200 filas limpias nunca habría recibido
    correo. Va después de la promoción, donde los dos desenlaces pasan.
  - ⚠️ **Cuenta CONCEPTOS contestables, no filas marcadas.** Una carga marcada solo por
    `invalid_date` produce CERO preguntas: el correo diría "6 filas que solo tú puedes
    clasificar" y aterrizaría en una pantalla vacía — el mismo fallo que `conceptos-pendientes`
    ya documenta del otro lado, y peor por correo, porque enseña a ignorar el próximo aviso.
    `esArreglablePorCategoria` salió de `modules/ingestion` a `lib/conceptos-pendientes.ts` y
    ahora tiene TRES consumidores (el GET, el POST y el worker): si el conteo del correo y la
    lista de la pantalla se separan, el producto promete un número y muestra otro.
  - **CONSOLIDAR e IDEMPOTENCIA se contradicen, y se resuelven en ejes distintos.** "Un solo
    correo si hay varias cargas" y "nunca dos correos del mismo documento" chocan cuando A
    termina y B treinta segundos después. La salida: la unidad de MENSAJE es la empresa y la de
    IDEMPOTENCIA el DOCUMENTO — cada envío escribe una fila de `notifications` por CADA
    documento que menciona. **No hace falta columna nueva**: `kind='review_needed'` +
    `ref_id=<documento>` ES ese registro, y encima es la tabla que el equipo puede mirar.
  - **El documento que dispara tiene que estar entre los NUEVOS, o no se manda nada.** Sin esa
    condición, terminar una carga limpia reabriría el aviso de otra ya avisada y el cliente
    recibiría un recordatorio cada vez que sube un archivo.
  - ⚠️ **La migración `0041` NO estaba en el ticket y es bloqueante.** `EmailSendPayload.kind`
    es un tipo de TypeScript; el que manda es el CHECK de `notifications.kind`, que seguía en
    `('report','alert','invitation')`. Sin ampliarlo el job **falla al insertar DESPUÉS de
    haber mandado el correo**: el cliente lo recibe y nosotros lo registramos como fallido. Es
    la lección que la 0017 ya dejó escrita al agregar `invitation`. `demo_request` no la
    necesitó porque va con `company_id` nulo y se salta la tabla — es la excepción, no el
    patrón.
  - **Destinatarios: los mismos que las alertas** (miembros activos con `receives_reports`). No
    se inventa un criterio: quien eligió no recibir el reporte tampoco quiere que le escribamos
    por una carga.
- **EL RESCATE DE HOJA Y LA CORRECCIÓN DE COLUMNA** (migración `0043`, 2026-09-01). El portón
  (0042) le ENSEÑA al dueño las dos cosas que más caro cuestan de esta ingesta y no le daba
  salida para ninguna: las veía y no podía hacer nada. Una hoja descartada por error —el
  dashboard de KapePrueba en cero con la contabilidad bien leída, la cartera de clientes que el
  filtro de catálogo se llevó puesta— y un dato leído de la columna equivocada, que no falla
  nada visible: el total puede verse perfecto y cada fila estar mal.
  Las dos se resuelven igual —reprocesar ESA hoja con la corrección— y por eso son **un solo
  endpoint** (`POST /documents/:id/corregir-hoja`) y **una sola columna**
  (`documents.sheet_overrides`).
  - **La corrección de columna se aplica INMEDIATAMENTE al volver del lote**, no más abajo:
    entre medio está la columna de la que el diccionario APRENDE el concepto, así que
    aplicarla después dejaba las reglas guardadas bajo la columna vieja — la corrección de esta
    carga no llegaba a la siguiente.
  - **Se borran las filas Y los lotes de esa hoja.** Sin lo primero, corregir la columna la
    DUPLICA; sin lo segundo, la reanudación la SALTA y la hoja desaparece — el mismo fallo que
    el rescate viene a arreglar, causado por nosotros. Hay un test por cada mitad.
  - **Una carga ya publicada no se corrige (409)**: sus filas están en el ledger y reprocesar
    encima las cuenta dos veces; ahí el camino es revertir y volver a subir. Y **no vuelve a
    cobrar crédito**: el débito es una vez por CARGA, no por corrida.
  - El resumen guarda ahora **todos los encabezados** de la hoja (`encabezados`): `columnas`
    dice de dónde SALIÓ el dato, y eso es lo que permite elegir otro.
- ⚠️ **UN REPROCESO NO PUEDE BORRAR LO QUE NO TOCÓ, Y ROMPIÓ DOS COSAS** (2026-09-01, las dos
  medidas en producción el mismo día que se desplegó el rescate). El worker es reanudable por
  lote a propósito, así que una corrida que vuelve sobre un documento **salta las hojas ya
  procesadas** — y todo lo que se acumula durante el bucle queda con solo lo de esa corrida.
  - **El RESUMEN DE LECTURA se guardaba con las hojas de esa corrida y borraba el resto.** El
    portón de `EL-INFIERNO-v43-2027.xlsx` pasó de **18 hojas a 9**, y las que desaparecieron
    eran las principales (`Ventas`, `Gastos_Operativos`, `OrdenesCompra`, `Facturacion`). Sus
    97 filas de staging seguían ahí, o sea que **la contabilidad no se perdía**: lo que se
    rompía era la única pantalla con la que el dueño decide si publicarla. Se fusiona por
    NOMBRE DE HOJA (`fusionarHojas`) y **gana la corrida nueva** — conservar el veredicto viejo
    sería peor que no fusionar: le diría que su corrección no sirvió.
  - **El CUADRE del documento comparaba una hoja contra el libro entero.** `leidoDelArchivo`
    acumula solo lo de esa corrida y el ledger tiene todo: medido, **GTQ 13.916,00 leídos
    contra 263.319,50 aterrizados, 18,92×**, gritando "la misma plata contada dos veces" sobre
    una carga cuyas tres cifras salieron EXACTAS. El falso positivo está GARANTIZADO en todo
    reproceso y encima se persiste (0040) en la cola de `/admin/reconciliation`. Es lo único
    que este mecanismo no puede permitirse — su propio encabezado ya lo dice: un detector que
    se equivoca en lo correcto enseña a ignorarlo. Ahora el cuadre del DOCUMENTO se omite en
    una corrida parcial y se dice por qué; el de POR HOJA sigue corriendo y sigue siendo válido
    (compara cada hoja re-leída contra SUS propias filas de staging) y es además el veredicto
    que ya manda cuando lo hay.
  - ⚠️ **El test del cuadre costó DOS correcciones y valen más que el arreglo**: (a) afirmaba
    que no hubiera un veredicto `sobra` y la mutación NO lo ponía en rojo, porque con el libro
    chico del test la corrida parcial da `cuadra` — ahora afirma que no haya NINGÚN veredicto
    de documento, que es lo que la guarda promete; (b) interceptaba `console.info` y
    `console.error` pero **no `console.warn`**, y `en_revision` —el falso positivo real— sale
    por ahí, así que seguía midiendo código distinto del que yo creía estar tocando.
- ⚠️ **CUATRO DEFECTOS MÁS QUE SOLO APARECIERON PROBANDO EL RESCATE DE HOJA EN PRODUCCIÓN**
  (2026-09-01). Ninguno mueve una cifra: son de PÉRDIDA, agotamiento o encierro, que es la
  clase que este pipeline no tenía instrumentada.
  - **Una carga trabada sin salida.** `cancel` solo aceptaba `queued` y `processing`, y el
    portón (0042) creó un estado terminal nuevo que nadie le agregó. Verificado: tres cargas de
    la empresa `test` que el cliente no podía sacarse de encima, y su única alternativa era
    PUBLICAR datos que sabe que están mal para después revertirlos — el trámite bloqueante que
    la 0020 eliminó, reintroducido sobre la carga entera. Ahora entran
    `awaiting_confirmation`, `review` y `failed`; los tres tienen en común que **no publicaron
    nada**. `promoted` NO entra aunque tenga filas retenidas: ahí hay datos que el cliente está
    usando y el gesto correcto se llama `revert`.
  - **Descartar no era descartar.** `POST /confirmar` solo miraba `confirmed_at`, así que un
    documento `cancelled`, `reverted` o `failed` se podía "publicar" y **volvían al dashboard
    filas que el cliente había dado de baja** (sus `staging_rows` siguen ahí: cancelar marca el
    documento y da de baja el ledger, no toca staging). Es la lección que
    `encolarPromocionDeLoResuelto` ya tenía escrita, aprendida en un llamador y sin aplicar en
    el otro. Estaba tapado por casualidad: la secuencia descartar→publicar no existía porque no
    se podía descartar.
  - **Un `:id` malformado colgaba una conexión.** `GET /documents/undefined/confirmacion` daba
    **500** y dejaba una conexión RESERVADA que el watchdog mataba 90 s después. Al frontend le
    basta un `documentId` en `undefined`, y **el pool son 10**: unas pocas peticiones así lo
    agotan, y "el login está roto" es el síntoma con el que eso se reporta. Las nueve rutas
    `:id` declaran `format: 'uuid'` y Elysia rechaza con 422 antes del handler — sin conexión,
    sin error de Postgres, sin nada que limpiar.
  - **Dos correcciones seguidas se pisaban y la carga terminaba en `failed`**: cada corrida
    borra las filas y los lotes de su hoja mientras la otra los escribe. El frontend ya
    deshabilitaba el control, pero **la UI no es donde se garantiza nada** — basta una pestaña
    duplicada. Ahora es 409 y no se encola en silencio.
- ⚠️ **UN PERFIL DE COLUMNAS VIEJO TUMBABA LA CARGA ENTERA** (2026-09-01, el más grave de la
  tanda y **anterior a todo esto**). El worker documenta desde CU-868krmrcj que el perfil es
  *"una pista, no una orden… El perfil nunca aborta una carga"*, y el código lo metía por
  `columnsCanonicas`, o sea por el único camino que lanza `MapaDeColumnasInconsistente`. Le pasa
  a **cualquier cliente que cambie el formato de su Excel**, y basta UNA hoja para perder el
  archivo completo: 0 filas, `failed`, y el único rastro es el `errorReason`.
  Medido: tras corregir a mano la columna de una hoja, el perfil aprendió esa corrección y la
  siguiente carga del mismo formato falló entera ("amount: 3 vs 4"). El picker de columna lo
  vuelve fácil de disparar, pero no lo causó.
  Las dos fuentes ya no comparten parámetro: `columnsCanonicas` (lo que fijaron los lotes de
  ESTA corrida) aborta ante conflicto y debe; `columnsSemilla` (el perfil, o sea el archivo de
  la ÚLTIMA vez) no aborta — **gana el lote, que está mirando el archivo de hoy**.
  ⚠️ **Y la decisión se extrajo a `mapaDelLote`, que es la parte que vale como método**: vivía
  dentro de `classifySheetRows`, y **los tests e2e doblan esa función entera**, así que ninguna
  prueba la ejecutaba nunca. El primer test de integración que escribí quedaba en VERDE al
  revertir el arreglo — medía código que el doble reemplaza. Se quitó (queda la nota en su
  lugar) y la conducta se comprueba sobre la función extraída, donde la mutación sí la ve.
- **CADA HOJA DICE A QUÉ PANTALLAS LLEGA, NO SOLO AL DASHBOARD** (`lib/destinos-de-la-fila.ts`,
  reporte de Jose 2026-09-01). *"La data no va únicamente al dashboard… si ponemos solo los del
  dashboard y el campo va a cuentas por pagar, no lo estamos registrando."* El portón (0042)
  mostraba el DINERO y el TIPO de cada hoja —los rubros del dashboard— y callaba que la misma
  fila puede aterrizar en Por cobrar, Por pagar, Inventario o Ventas por producto: el dueño
  aprobaba su archivo viendo una parte de lo que hace.
  No hubo que inventar nada, **el destino ya estaba determinado en la fila**: `targetEntity`
  decide la tabla, `type` el rubro y `product` si alimenta Ventas por producto. Lo que faltaba
  era decirlo.
  - **Los casos que importan son los que llegan a MÁS de una pantalla**, que es justo lo que
    faltaba: una factura emitida va a Por cobrar **y** a Ingresos (emitirla devenga); una cuenta
    por pagar va a Por pagar **y** a Costos. Listar solo la cuenta escondía la mitad que el
    cliente ve en su dashboard.
  - ⚠️ **`other` se declara SIN PANTALLA y eso es el punto**: `rollups.ts` suma
    revenue/cogs/opex, así que esa fila se guarda y no aparece en ninguna cifra. Jose preguntó
    por escrito dónde caía y la respuesta honesta es "en ningún lado que se vea". Se muestra en
    tono de AVISO y no como un destino más, porque es lo único de la lista que hay que corregir.
    Verificado de punta a punta: una hoja `other` de GTQ 6.300 se reclasificó desde el portón y
    el opex subió exactamente esa cifra.
  - ⚠️ De paso: **los TIPOS por hoja salían del mismo `limit(400)` que las tres filas de
    ejemplo**. Eso es una afirmación sobre toda la hoja calculada con las primeras 400 filas del
    DOCUMENTO — en un archivo grande la última hoja no aportaba ni un tipo y la pantalla decía
    "entró como ingreso" sin haberla mirado. Ahora es una consulta agregada.
- **TODAS LAS PANTALLAS, SIEMPRE, Y EL DUEÑO PUEDE MANDAR UNA HOJA AL INVENTARIO** (2026-09-02,
  segunda vuelta del mismo reporte). *"Solo añadiste dos, debería ser bueno mostrar
  absolutamente todas las que tenemos en Macha. En Analítica tenemos ingresos, flujo de caja,
  costos, por cobrar y por pagar. Luego ventas por producto, y luego inventario… que se muestren
  todas siempre de una manera bonita y ordenada."*
  - **Faltaban dos pantallas en el mapa**: `flujo` (Analítica → Flujo de caja) y `tiendas`
    (el desglose por tienda dentro de Ventas por producto), las dos entradas propias del menú.
    `flujo` se agrega exactamente cuando la fila suma en el estado de resultados —es la misma
    serie mensual de `monthly_rollups`— y `tiendas` solo sobre ingresos, igual que `productos`:
    un gasto con sucursal contaría ahí como si esa tienda hubiera vendido lo que gastó.
  - **La lista de OPCIONES se calcula en el backend** (`opcionesParaConcepto`) y viaja resuelta
    al frontend: qué se puede contestar, a qué pantallas llega cada respuesta, cuál no se puede
    elegir y por qué. Escribirla en el componente sería la copia número dos del mapa de
    destinos, en el único lugar donde una divergencia se le muestra al cliente como una promesa
    sobre su plata.
  - **SIEMPRE son seis y lo que no se puede elegir se APAGA con su motivo**, nunca desaparece.
    Que las dos de cuenta aparecieran "solo a veces" es lo que el dueño reportó como
    inconsistente (*"veo que añadí estas pero solo a veces, aquí no por ejemplo"*), y el
    problema es más profundo que la estética: **una lista que cambia de largo no se puede
    aprender** — el cliente no llega a saber qué puede contestar. `yaEsAsi` gana a
    `variasHojas`: un concepto que ya está donde debe no necesita que le expliquen un
    impedimento que no le importa.
  - ⚠️ **EL RUBRO SALE DE LA DERIVACIÓN REAL, NO DEL `type` DE LA FILA**, y se corrigió
    **viendo la promesa falsa en producción** minutos después de desplegar los chips: para un
    concepto que ya es cuenta por pagar, "Un ingreso" mostraba `Por pagar · Ingresos · Flujo de
    caja`. Es falso. `rollups.ts` suma solo de `transactions`, así que una factura aparece en el
    estado únicamente si `construirFilas` derivó su transacción — y esa derivación tiene reglas
    propias y DISTINTAS por entidad: una `bill` deriva su costo **solo** con `cogs`/`opex` (con
    `revenue` entra a Por pagar y no suma en ninguna cifra), y una `invoice` deriva su ingreso
    con `type: 'revenue'` **fijo**, sin mirar el tipo del modelo. Los chips existen para que el
    dueño decida informado; uno que miente es peor que no ponerlo. Ninguno de los tests que ya
    había cubría `bill + revenue`.
  - ⚠️ **`sinPantalla` solo cuando de verdad no queda NINGUNA**, y con el tipo ya decidido. Una
    `bill` con `revenue` tampoco suma en el estado pero SÍ está en Por pagar — decir "no aparece
    en ningún lado" sería la misma mentira del otro lado. Y con `type` en `null` la fila está
    sin clasificar: falta su respuesta, no su pantalla.
  - **DESTINO `inventario` POR HOJA, y cierra un hueco MEDIDO.** Cuarta opción de "¿Dónde se
    registra?". No es una entidad del ledger sino **otro camino**: el worker la desvía arriba de
    los cinco filtros y va a `inventory-import` sin pagar un token. Es la salida al hueco que
    este archivo ya tenía escrito y sin cerrar —*"un inventario serializado que ninguna otra
    hoja referencia entra como GASTO… Q 1.864.500 de egreso que nadie desembolsó"*—: la nota
    decía que el arreglo no es aflojar el esquema del libro (hay contraejemplo en un test que ya
    existe), y esta es la otra salida y es mejor, porque no es una heurística más — **lo afirma
    el dueño**, que sabe qué hay en su bodega. Ninguna de las dos detecciones automáticas se
    toca, así que no puede empeorar un archivo que hoy entra bien.
  - ⚠️ **`mapearInventarioForzado` prefiere el camino FUNGIBLE cuando hay columna de cantidad.**
    Al revés, una hoja de bodega con `SKU · Descripción · Existencia` tiene el SKU único por
    fila, entraría como serializada —UNA unidad por SKU donde hay cuarenta— y el inventario del
    cliente saldría en 1. La columna de serie sale de `columnasClave`, la MISMA con la que el
    esquema del libro decide qué es un identificador: una segunda definición de "esto parece una
    clave" se traduce en artículos inventados. Si no mapea se DICE y se descarta; mandarla de
    vuelta al modelo reintroduciría el costo falso que el dueño está corrigiendo.
  - Medido en el e2e nuevo, en dos tiempos: sin decir nada la hoja de stock entra como
    GTQ 1.050.000 de costo con el inventario en cero; forzada, cero filas de staging y seis
    artículos a una unidad cada uno, y resubirla no duplica ("0 altas, 6 sin cambio").
  - ⚠️ **Y «mi inventario» va TAMBIÉN en la tarjeta de conceptos, no solo en el portón**
    (reporte de Keneth mirando la pantalla, mismo día: *"pero inventario no aparece acá"*).
    Se había agregado a un solo lado, así que el portón ofrecía CUATRO destinos y la tarjeta
    SEIS opciones sin inventario: **la lista de dónde puede ir la data era distinta según dónde
    mirara el dueño**, que es la misma inconsistencia que motivó todo esto, movida de sitio.
    Y hay un caso real: si una hoja de existencias llegó hasta la tarjeta, ahí es donde el
    dueño está mirando el código que no reconoce — mandarlo al portón a buscar la hoja es
    pedirle que resuelva en otra pantalla el problema que tiene delante. **La lección que
    generaliza: una opción nueva va en TODAS las pantallas que hacen la misma pregunta, o la
    inconsistencia solo cambia de lugar.**
  - ⚠️ **El aviso del reproceso tuvo que volverse GENÉRICO al sumarlo**: decía *"volvemos a leer
    la hoja para sacar el CLIENTE y el VENCIMIENTO de sus columnas"*, cierto de las dos cuentas
    y FALSO del inventario — una lista de existencias no tiene ninguno de los dos. Un aviso solo
    para las tres tiene que decir lo único que las tres comparten, o promete algo que no va a
    pasar. Lo específico lo lleva cada tarjeta en su pie.
  - **Orden de deploy: FRONTEND primero.** Es el lado tolerante (sin `opciones` cae a las cuatro
    de siempre), así que puede esperar la clave nueva antes de que exista. Al revés, el backend
    mandaría una clave que el componente no sabe pintar.
- **Y LA MUESTRA ENSEÑA TODOS LOS CAMPOS, NO LOS DEL ESTADO DE RESULTADOS**
  (`lib/campos-de-la-fila.ts`, mismo reporte). *"Los campos realmente cabal son los campos que
  vos ya tenés en la base de datos, o sea que sólo con agregarlos ahí deberíamos estar check."*
  Los destinos por hoja fueron la mitad; esta es la otra. La muestra pintaba **seis campos
  elegidos a mano** —fecha, concepto, monto, moneda, tipo, categoría— que son justo los que
  alimentan el estado de resultados. El pipeline extrae ONCE, y los cinco que faltaban son los
  que mandan en las otras pantallas:
  - ⚠️ **`dueDate` es el más grave y no se enseñaba EN ABSOLUTO.** Decide el TRAMO DE ANTIGÜEDAD
    de Por cobrar y Por pagar (corriente, 1-30, 31-60, 61-90, 90+), o sea cómo se ve esa
    pantalla entera. Un vencimiento mal leído manda la cartera al tramo equivocado **sin cambiar
    un solo total**, así que ni el cuadre lo detecta ni el dueño lo veía: aprobaba su cartera
    sin ver el campo que la ordena.
  - `counterparty` (quién debe o a quién se le debe), `product` y `productCategory` (Ventas por
    producto) iban COLAPSADOS dentro de "concepto", y solo si la fila no traía descripción.
    `quantity` y `store` (Inventario, Ventas por tienda) no aparecían.
  - **Se pintan los que la fila TRAE, no una lista fija**: una hoja de gastos no tiene producto
    ni tienda, y seis renglones vacíos convierten la pantalla en ruido — que es lo que hace que
    el dueño deje de leerla.
  - ⚠️ **Una cantidad de CERO sí se pinta.** Es un valor legítimo del inventario y significa
    algo (no hay existencia); tratarlo como ausente escondería justo la fila que hay que mirar.
    Hay test y la mutación `if (!v) continue` lo pone en rojo.
- **EL DUEÑO CORRIGE DÓNDE SE REGISTRA UNA HOJA** (`sheet_overrides.destino`, reporte de Jose
  2026-09-01). *"Si ponemos solo los del dashboard y el campo va a cuentas por pagar, no lo
  estamos registrando."* Las cuatro opciones que el cliente veía —ingreso, costo, gasto, otro—
  son los `type` del ESTADO DE RESULTADOS. La ENTIDAD (movimiento / cuenta por cobrar / cuenta
  por pagar) la decidía solo la estructura de la hoja, y cuando se equivocaba **no había forma
  de corregirla**. El caso no es hipotético: una hoja de cobros tiene fecha, cliente y monto, así
  que el modelo la clasifica `transaction/revenue` —la regla "un cobro no es una venta nueva"
  existe por eso— y entonces el ingreso entra al dashboard con la cartera en CERO. La única
  salida era revertir y pedirle al cliente que editara su Excel.
  Esto **matiza la decisión de Semi** de que *"el cliente decide `type` y `category`, NO
  `entity`"*: sigue siendo cierta para la fila (la forma contable la determina la estructura),
  pero cuando la estructura se leyó mal el dueño tiene que poder decirlo, y lo dice por HOJA.
  - ⚠️ **ES UN REPROCESO Y NO UN `UPDATE`, y eso decide el diseño**: el payload de una
    `transaction` **no guarda `counterparty` ni `dueDate`** (ver `assemblePayload`). Convertirla
    desde la fila ya guardada perdería los dos campos con los que se lee Por cobrar — y el aging
    se calcula con el vencimiento. Hay test unitario que lo fija: la misma fila como `invoice`
    los trae y como `transaction` no.
  - **Por HOJA y no por concepto**: una hoja es homogénea por construcción —quien escribe
    `CuentasPorCobrar` no mete ventas ahí— y un concepto puede agrupar filas de varias hojas,
    donde el cambio sería ambiguo.
  - **Son DOS preguntas separadas, no seis opciones en una lista.** No son alternativas: una
    factura emitida es a la vez un INGRESO y una CUENTA POR COBRAR, así que mezclarlas obligaría
    al dueño a elegir entre dos respuestas que ambas son ciertas y perdería la mitad.
  - ⚠️ **`aplicarEntidadForzada` se EXTRAJO de `classifySheetRows`** por la misma lección que
    `mapaDelLote`: los e2e doblan esa función entera, así que lo que vive adentro no lo ejecuta
    ninguna prueba. El forzado se escribió primero ahí y el e2e pasó en VERDE con las filas
    todavía en `transaction`. Ahora el doble llama al mismo código y mutarlo lo pone en rojo.
  - `skip` no se toca: el modelo dijo que esa fila no es un movimiento y forzarle una entidad la
    convertiría en dinero.
  - El e2e fija además que forzar `invoice` produce el **DOBLE** de filas —la cuenta por cobrar
    y su ingreso devengado—, que es la regla del 2026-08-19 funcionando. Con solo la mitad, el
    dinero estaría en Por cobrar y el dashboard en cero: el bug de U3TECH.
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
- **`costKnown` faltaba en el esquema de respuesta de `/metrics/products`** (2026-08-31).
  Elysia recorta en silencio lo que el esquema no declara. `productPerformance` calcula ese
  campo y documenta por qué es imprescindible —`cogs` se agrega con `coalesce(..., 0)`, así que
  un producto SIN costo cargado es indistinguible en el número de uno que costó cero, y los dos
  salen con 100 % de margen— y el campo **moría en el borde HTTP**: la pantalla de Ventas por
  producto nunca lo recibió. El asesor IA sí lo ve, porque llama a la función directo, o sea que
  **el chat y la pantalla podían contestar distinto sobre el mismo producto**. Solo se ve
  pidiendo el ENDPOINT; ningún test que consulte la función o la tabla podía verlo. Pendiente
  del lado del frontend: consumirlo y pintar el aviso.
- **El texto del banner de ingesta contradecía la promoción parcial, tres semanas**
  (`ingest-status-banner`, corregido 2026-08-31). Decía *"Nada entra a tus reportes hasta que la
  carga completa esté revisada"* y desde la migración `0020` —promoción PARCIAL, decisión de
  Keneth del 2026-08-07— **las filas limpias entran solas**. El comentario del propio componente
  seguía describiendo la atomicidad vieja. No es redacción: el correo de confirmación que se está
  construyendo dice —bien— que "el resto de tus datos ya está en tu dashboard", así que los dos
  mensajes se contradicen sobre la misma carga con minutos de diferencia. Y el texto además
  decía que las filas "necesitan que **las revisemos**", cuando desde el acuerdo con Semi
  (2026-08-20) las contesta el CLIENTE. Corregido en ES y EN.
- **El resumen de lectura muestra el DINERO de cada descarte**, no solo las filas
  (`read-summary`, 2026-08-31), y el descarte por "no hay fecha con dinero al lado" dejó de
  reportarse como `catalogo`. Ese motivo afirma que la hoja *"describe tus clientes, productos o
  proveedores"* —algo sobre el CONTENIDO que no sabemos—; cuando la explicación no le calza a lo
  que el dueño tiene delante, deja de creerle al resumen entero, que es la única herramienta con
  la que puede desmentirnos. Motivo nuevo: `sin_fecha_ni_monto`.
- **El panel de conceptos pregunta UNA A LA VEZ** (`conceptos-pendientes`, CU-868kyur58,
  2026-09-01), replicando el HTML que aprobó Jose. Antes listaba todos los conceptos apilados
  con un `<Select>` chico y un `<Input>`: se sentía como un formulario de trabajo cuando lo que
  el cliente tiene que hacer son dos o tres decisiones sobre su propio negocio.
  **Es un cambio de PRESENTACIÓN**: mismo contrato, mismo endpoint, **una sola llamada** al
  guardar con todas las respuestas juntas — un POST por concepto daría cuatro promociones
  encoladas y un dashboard moviéndose a pedazos. Hay test que monta el componente y comprueba
  que las respuestas de los conceptos anteriores SOBREVIVEN al avanzar: perderlas al llegar a
  la cuarta pregunta es trabajo que el dueño ya hizo.
  - Las cuatro opciones de "qué es" son `role="radio"` de verdad, no `div`s con `onClick`:
    cuatro tarjetas que se ven elegibles y que el teclado no alcanza son media implementación.
  - El punto CONTESTADO del progreso usa el verde FUNCIONAL y el actual la tinta de marca —
    "esto ya está" es estado del dato; el salvia queda para "esto es Macha" (el orbe y el
    resalte del concepto). Invertirlos haría que el color de marca significara progreso.
  - **Omitir el ÚLTIMO concepto guarda lo ya contestado** en vez de tirarlo. Y sin rubro escrito
    el botón principal está deshabilitado, así que "omitir" es el único camino para pasar de
    largo una pregunta — eso es deliberado, no un bug.
  - Los radios salen de la ESCALA (`rounded-lg`), no en píxeles: hay un test que lo vigila.
  - ⚠️ **CUATRO DEFECTOS QUE SOLO SE VIERON ABRIENDO LA PANTALLA EN CHROME** (2026-09-01, con la
    suite entera en verde y el deploy ya en producción). Los dos son de la clase que ningún
    test de fuente puede ver, y valen más como método que como arreglo:
    1. **La celda de la tabla lleva `whitespace-nowrap`** —para que el NOMBRE DEL ARCHIVO no se
       parta— y esa regla se hereda a toda la prosa del panel expandido. Medido en producción:
       con el panel cerrado la tabla mide exactamente su contenedor (1164 px) y al abrir la
       tarjeta pedía 1278. El contenedor tiene `overflow-x: auto`, **así que nada falla**: el
       cliente simplemente tiene que hacer scroll lateral para leer la pregunta que le estamos
       haciendo, y la respuesta queda cortada por la derecha. El envoltorio del panel repone
       `whitespace-normal`. Generaliza a cualquier contenido nuevo dentro de esa celda.
    2. **El disparador cerrado decía "Ayúdanos a clasificar 0 concepto(s)".** `conceptos` es
       `undefined` hasta que alguien ABRE el panel —que es cuando se pide la lista— y el conteo
       caía a `?? 0`. O sea que el control que existe para que el cliente conteste le informaba,
       antes de tocarlo, que no hay nada que contestar: la razón más directa para no hacer clic,
       y el mismo modo de fallo que este archivo ya documenta del lado del correo ("un aviso que
       aterriza en una pantalla vacía enseña a ignorar el próximo"). Sin lista todavía, el texto
       no lleva número (`ctaSinConteo`).
    3. **El botón principal quedaba HABILITADO con el rubro vacío desde la segunda pregunta.**
       `disabled` miraba `listas.length === 0` —las respuestas ACUMULADAS— así que el candado
       solo protegía a la PRIMERA: contestada una, el cliente podía leer "Guardar y seguir",
       apretarlo con el campo vacío, y ese concepto quedaba sin contestar sin que nada se lo
       dijera. Y **los dos tests que cubrían la regla pasaban en verde**, porque afirmaban el
       STRING `disabled={guardando || listas.length === 0}` en vez de la conducta — el mismo
       error que `email-shell.test.ts` ya documenta con el logo ("probaba la implementación, no
       lo que el cliente de correo necesita"). Ahora la condición mira el concepto en pantalla
       y la conducta se mide MONTANDO el componente.
    4. **El scroll del deep link se disparaba UNA vez y llegaba demasiado pronto.** Medido con
       el enlace del correo: la fila aparece a los ~375 ms midiendo 152 px, se llama
       `scrollIntoView`, y `scrollY` se queda en **0** — con el panel cerrado el documento
       apenas pasa el alto de la ventana, así que no hay a dónde scrollear. Un segundo después
       el panel se abre solo, la fila pasa a 716 px, el documento a 1473, y quedaban **549 px**
       de scroll que nadie volvía a pedir: la fila resaltada abajo del pliegue y la pregunta
       fuera de la vista. Ahora se RE-AFIRMA mientras la fila crezca (`ResizeObserver`) y se
       deja de insistir cuando deja de crecer o si el cliente scrollea por su cuenta —
       arrebatarle la pantalla a quien decidió mirar otra cosa es peor que no hacer scroll.
       ⚠️ El test de ese eslabón afirmaba `MutationObserver` + `scrollIntoView` en la fuente y
       **pasaba en verde con el scroll roto**: esperar a que la fila EXISTA no es lo mismo que
       llegar cuando hay layout. La conducta la mide `deep-link-scroll.test.tsx`, que monta la
       pantalla y hace crecer la fila.
    La lección de método: **una tarjeta nueva dentro de una tabla existente hereda reglas de
    layout que su propio render no ve**, y el precio se paga en el navegador del cliente. Los
    dos quedan fijados en `tarjeta-guiada.test.tsx`, comprobados por mutación; el del ajuste de
    línea se afirma sobre la fuente de `document-list` porque la regla vive en la celda.
- **El banner de ingesta VE las cargas que promovieron parcial** (2026-09-01). Filtraba por
  `status === 'review'`, y desde la migración `0020` una carga con conceptos pendientes termina
  en `promoted` con `flagged_count > 0` — el caso NORMAL; a `review` solo llega la que no
  promovió NADA. Verificado en producción: una carga con 3 conceptos pendientes no aparecía en
  el banner mientras este anunciaba los 12 de otro documento, o sea que el control que dice
  "esto te está esperando" se perdía el caso más común. Es el **mismo punto ciego** que
  `lib/aviso-de-revision.ts` documenta haber corregido para el correo: estaba aprendido de un
  lado y sin aplicar del otro. ⚠️ Su test sustituye `globalThis.fetch` y **no** dobla
  `@/lib/api/browser`: `mock.module` es global al proceso y la primera versión puso en rojo
  cuatro tests de `aceptar-invitacion.test.tsx`, que ya documenta ese choque y su salida.
- **El deep link `/upload?doc=<id>`** (mismo ticket). El correo y el banner del Dashboard llevan
  al documento exacto: la fila queda resaltada, la pantalla hace scroll hasta ella y su panel de
  preguntas se abre solo. Son CUATRO piezas encadenadas (página → pantalla → lista → panel) y
  **cortar cualquiera deja el flujo donde estaba, sin que nada falle** — por eso hay un test por
  eslabón (`deep-link.test.ts`).
  - El `?doc=` se lee en el SERVIDOR: leído en el cliente, quien viene del correo vería la lista
    normal y después un salto.
  - El scroll usa `MutationObserver` porque la lista se carga por `fetch` DESPUÉS del primer
    render — al montar la pantalla la fila todavía no existe, y un `setTimeout` adivinaría
    cuánto tarda la petición.
  - El resalte es `outline` y no `border`: un borde correría la tabla entera justo cuando el
    cliente aterriza, y el scroll apuntaría a donde la fila ya no está.
  - Un `doc` que ya no corresponde a nada degrada a la vista normal, **sin error**: un enlace de
    un correo de hace tres días no puede terminar en una pantalla rota.
  - El banner enlaza al documento solo cuando hay UNO en revisión; con varios va a la lista.
    Resaltar uno de tres sugiere que los otros dos no necesitan nada — la misma decisión que
    toma el correo consolidado.
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
- **EL RESCATE DE HOJA Y EL PICKER DE COLUMNA EN EL PORTÓN** (2026-09-01). "Sí, esta hoja
  debería contar" sobre cada descarte y, dentro del panel expandido, de qué columna sale el
  monto. Hasta hoy la pantalla MOSTRABA las dos cosas más caras de esta ingesta —una hoja
  perdida y un dato leído de la columna equivocada— y no daba nada que apretar.
  - El picker manda el **ÍNDICE**, no el nombre: `sheet_overrides.columnas` se indexa por
    posición, igual que el mapa del modelo. Hay test.
  - Las dos correcciones **REPROCESAN** el archivo, así que no son un cambio local como
    excluir: se sondea el mismo endpoint hasta que el worker termina (tope de 2 min, y al
    agotarse se recarga igual para que el cliente vea el estado REAL en vez de una promesa).
    Mientras tanto los controles quedan deshabilitados — un segundo clic encolaría otra corrida
    sobre una carga que ya se está procesando.
  - Las hojas descartadas **sin un solo monto medido** van juntas y colapsadas. El corte es por
    DINERO y no por el nombre de la hoja: "Portada" es una convención y el próximo cliente la
    llamará "Carátula". Listadas sueltas hacen parecer que descartamos medio archivo cuando
    descartamos la carátula, y el ruido tapa el descarte que el dueño sí puede desmentir.
- ⚠️ **DOS DEFECTOS MÁS QUE SOLO SE VIERON ABRIENDO EL PORTÓN EN CHROME** (2026-09-01, con la
  suite en verde y el deploy en producción — es la tercera vez que esta pantalla los produce):
  1. **Una carátula no produjo "3 movimientos".** `Portada` y `Notas` se listaban como *"3
     movimientos · —"* entre las hojas que sí cuentan: la pantalla afirmando algo que no pasó,
     justo donde el dueño decide si publicar. **Y NO se esconden** como las descartadas sin
     dinero — una hoja que produjo filas va a publicar algo, así que agruparla contradiría el
     portón. Lo que estaba mal era el texto, no el sitio (`usadaSinMonto`).
  2. **El aviso de conceptos prometía un número que el panel desmentía.** Decía "Quedaron {n}
     conceptos" con `n` = FILAS MARCADAS mientras el panel de abajo —que cuenta CONCEPTOS
     contestables— decía otra cosa sobre la misma carga: medido, **30 arriba contra 4 abajo**.
     Es el mismo fallo que `conceptos-pendientes` documenta del lado del correo, y encima
     llamaba "conceptos" a las filas. Ahora el aviso **no lleva número**: el único conteo que
     vale lo da el panel, que es el que sabe cuántos son.
- **EL RANGO DEL ENLACE MANDA EN ANALÍTICA** (`/analytics?from=&to=`, 2026-09-01). La pantalla
  abría SIEMPRE en "este mes" y descartaba el rango en silencio, así que el enlace llevaba a un
  período distinto del que promete. Es el mismo daño que `hayDatosFueraDelRango` documenta y que
  costó un día entero: el cliente ve cifras correctas de OTRO período y concluye que el sistema
  no leyó su archivo.
  - Se lee en el SERVIDOR, como el `?doc=` de `/upload`: leído en el cliente, quien abre el
    enlace vería primero el mes en curso y después un salto.
  - Se valida con `validateCustomRange`, la MISMA del selector: una segunda validación se
    separaría de la primera y la URL aceptaría rangos que el formulario rechaza. Un rango
    incompleto, invertido o futuro degrada a "este mes" **sin error**.
  - El selector queda en «personalizado», que es lo que el rango ES. Sin eso la pantalla
    mostraría el rango del enlace con "Este mes" resaltado.
  - ⚠️ La decisión vive en `periodoInicial` (`lib/period.ts`), función pura. El primer test
    montaba la pantalla y espiaba `globalThis.fetch`: **`pedidos` se contamina entre tests**
    —los efectos del render anterior siguen disparando tras `cleanup()`— así que fallaba con el
    arreglo ya puesto. Sacar la decisión del componente la hace comprobable de verdad.
- ⚠️ **`tailwind-merge` BORRABA TODOS LOS TAMAÑOS DE TEXTO DEL PROYECTO** (2026-09-01). Su tabla
  de grupos es la de Tailwind por defecto, así que un `text-body` no le consta como tamaño: lo
  mete en el grupo de COLOR junto a `text-muted-foreground` y **descarta el primero**.
      twMerge('text-body text-muted-foreground')  →  'text-muted-foreground'
      twMerge('text-sm   text-muted-foreground')  →  las dos sobreviven
  Pasa en CUALQUIER componente que combine un tamaño propio con un color en un `cn()`, y no
  falla nada: el elemento se queda con el **16px del navegador**. Medido en producción: los tabs
  de Analítica declaran `text-body` (14px) y llegaban al DOM sin esa clase. El reporte de Jose
  era *"siento que los tabs son demasiado grandes, aunque la letra y las gráficas son bastante
  grandes"* y **la causa no era de diseño: el tamaño nunca se aplicó**. Tras el arreglo, 60
  elementos de esa sola pantalla recuperaron su tamaño.
  Es el mismo modo de fallo que `chart-theme.ts` documenta con las clases de Tremor: la clase se
  escribe, no llega, y nadie lo nota porque no hay error. El arreglo va en `lib/cn.ts`
  (`extendTailwindMerge` con la escala del proyecto) y no en el componente que lo destapó —
  arreglar solo los tabs habría dejado el resto de la escala roto y sin nadie mirándolo. Hay
  test que compara la lista contra `fontSize` de `tailwind.config.ts`, porque un token nuevo
  que no se sume ahí se empieza a perder en silencio.
- **La rampa de marca no estaba donde el reporte la buscaba** (mismo día). El ticket de colores
  se cerró aplicando `chartCategorico` a los dos donuts de Ventas por producto; las barras de
  participación de "Ingreso por producto" en Analítica seguían en tinta plana — y esa es la
  pantalla que Jose estaba mirando cuando dijo *"el ticket fue completado y no veo el cambio"*.
  La propia documentación de `chartCategorico` nombra "top de productos" explícitamente.
  `chartCategoricoClase` es la MISMA rampa como clases de Tailwind, para las barras que no son
  de Tremor. Dos tests la protegen: el mismo ORDEN y los mismos tonos que la de Tremor (si
  divergen, una categoría sale de un color en el donut y de otro en la lista), y que las clases
  estén escritas **literales** — una construida por concatenación la purga Tailwind, que es el
  fallo de los ticks negros ya documentado.
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
