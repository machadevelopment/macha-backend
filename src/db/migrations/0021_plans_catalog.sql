-- Catálogo de planes (ticket B3 de la ronda de QA del 2026-08-11).
--
-- POR QUÉ EXISTE. `subscriptions.plan_code` era `text NOT NULL DEFAULT 'base'`: texto
-- libre. No había ningún lugar donde estuviera escrito qué planes existen, cuánto cuesta
-- cada uno ni cuántos créditos trae — el único valor que se escribía era el literal
-- `'base'` hardcodeado en `modules/billing/register.ts`. Con eso, "cambiar de plan" no era
-- una operación posible: no hay a qué cambiarse.
--
-- Idempotente como todas: `migrate.ts` aplica CADA archivo en CADA invocación.
--
-- ⚠️ ESTA MIGRACIÓN NO SIEMBRA LOS PLANES COMERCIALES. CLAUDE.md separa migraciones de
-- schema (auto-aplican al desplegar) de migraciones de datos (scripts manuales), y los
-- tres planes del demo —Starter/Medium/Enterprise, con sus precios— son datos de negocio
-- que se ajustan sin desplegar. Van en `scripts/seed.ts`.
--
-- Lo que SÍ hace acá es el BACKFILL del paso 2, que es otra cosa: sin él la llave foránea
-- del paso 3 no se puede crear sobre una base que ya tiene suscripciones. Hacer que los
-- datos existentes satisfagan una restricción nueva es parte del cambio de schema, no una
-- siembra.

-- ---------------------------------------------------------------------------
-- 1) plans — el catálogo.
-- ---------------------------------------------------------------------------
-- `code` es la PK y no un uuid: es la llave natural, es la que ya vive en
-- `subscriptions.plan_code`, y es la que un operador lee. Un uuid obligaría a un join
-- para responder "¿en qué plan está esta empresa?" y a migrar el valor existente.
--
-- `monthly_credits` es integer y no numeric: un crédito es una unidad entera que el
-- cliente ve y cuenta. El dinero de la plataforma se mide en `cost_usd` (numeric) del
-- lado de `ai_usage_events`; esto es otra cosa.
--
-- `amount_usd_cents` en centavos enteros, igual que `subscriptions.amount_usd_cents` y
-- `payments.amount_usd_cents`, para no introducir una segunda representación de precio.
CREATE TABLE IF NOT EXISTS plans (
  code text PRIMARY KEY,
  name text NOT NULL,
  amount_usd_cents integer NOT NULL,
  monthly_credits integer NOT NULL,
  -- Orden de presentación. Sin esto la comparación de planes en pantalla dependería del
  -- orden de inserción, y "Enterprise, Starter, Medium" no se lee como una escalera.
  sort_order integer NOT NULL DEFAULT 0,
  -- Baja lógica y no DELETE: una empresa puede seguir suscrita a un plan retirado del
  -- catálogo, y borrar la fila rompería la FK del paso 3 o dejaría a esa empresa sin plan.
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Precio y créditos no negativos. Un plan gratuito (Starter) es 0, válido; un negativo no
-- significa nada y rompería el cálculo de la asignación.
DO $$ BEGIN
  ALTER TABLE plans DROP CONSTRAINT IF EXISTS plans_amount_chk;
  ALTER TABLE plans ADD CONSTRAINT plans_amount_chk CHECK (amount_usd_cents >= 0);
  ALTER TABLE plans DROP CONSTRAINT IF EXISTS plans_credits_chk;
  ALTER TABLE plans ADD CONSTRAINT plans_credits_chk CHECK (monthly_credits >= 0);
END $$;

-- El listado del cliente pide solo los activos, ordenados.
CREATE INDEX IF NOT EXISTS plans_active_sort_idx ON plans (active, sort_order);

-- ---------------------------------------------------------------------------
-- 2) Backfill: todo plan_code que ya exista tiene que existir en el catálogo.
-- ---------------------------------------------------------------------------
-- Sin esto, el paso 3 falla en cualquier instancia con suscripciones (staging y prod la
-- tienen: toda empresa registrada nació con `plan_code = 'base'`).
--
-- Las filas nacen INACTIVAS a propósito. `base` es un plan histórico, no comercial: no se
-- debe ofrecer a nadie nuevo, pero las empresas que ya están en él lo conservan. Su precio
-- se copia de lo que esas suscripciones ya cobraban —`max()` porque el catálogo tiene un
-- precio por plan y las filas podrían diferir— y sus créditos quedan en 0, que es lo
-- honesto: nunca hubo un paquete de créditos asociado a `base`, el abono inicial salía de
-- `platform_settings.credit_initial_grant` y sigue haciéndolo mientras el plan no declare
-- los suyos.
INSERT INTO plans (code, name, amount_usd_cents, monthly_credits, sort_order, active)
SELECT
  s.plan_code,
  initcap(replace(s.plan_code, '_', ' ')),
  COALESCE(max(s.amount_usd_cents), 0),
  0,
  0,
  false
FROM subscriptions s
GROUP BY s.plan_code
ON CONFLICT (code) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 3) La suscripción REFERENCIA el catálogo, ya no es texto libre.
-- ---------------------------------------------------------------------------
-- Es el punto del ticket: "la suscripción referencia un plan del catálogo, no el planCode
-- de texto libre". Con la FK, un typo en el código de plan deja de ser una suscripción
-- silenciosamente rota que solo se descubre cuando alguien mira la factura.
--
-- Sin ON DELETE: el default (NO ACTION) es justo lo que se quiere — un plan con
-- suscripciones vivas NO se puede borrar. Para retirarlo del catálogo está `active`.
--
-- `NOT VALID` + `VALIDATE` en dos pasos: la primera sentencia toma un lock corto y no
-- escanea la tabla, la segunda valida sin bloquear escrituras. Con el backfill del paso 2
-- la validación no puede fallar, pero el patrón se mantiene porque es el correcto para
-- una tabla que crece.
DO $$ BEGIN
  ALTER TABLE subscriptions DROP CONSTRAINT IF EXISTS subscriptions_plan_code_fk;
  ALTER TABLE subscriptions ADD CONSTRAINT subscriptions_plan_code_fk
    FOREIGN KEY (plan_code) REFERENCES plans (code) NOT VALID;
  ALTER TABLE subscriptions VALIDATE CONSTRAINT subscriptions_plan_code_fk;
END $$;

-- ---------------------------------------------------------------------------
-- 4) SIN RLS, y eso es deliberado.
-- ---------------------------------------------------------------------------
-- Toda tabla nueva de las migraciones anteriores (0014 `document_ingest_batches`, 0017
-- `company_invitations`) habilita RLS. `plans` NO, porque no tiene `company_id`: es un
-- catálogo GLOBAL de la plataforma, como `platform_settings`. No hay nada que aislar entre
-- inquilinos — todas las empresas ven los mismos planes, y esa es justamente la función de
-- la tabla. Una política de RLS acá no protegería nada y solo agregaría una forma de
-- romper el listado.
--
-- Lo que sí sigue siendo tenant-scoped es `subscriptions`, que ya tiene su RLS de 0009 y
-- es la que dice QUÉ empresa está en QUÉ plan.

-- ---------------------------------------------------------------------------
-- 5) Permisos del rol de aplicación.
-- ---------------------------------------------------------------------------
-- La migración 0010 dejó puesto `ALTER DEFAULT PRIVILEGES`, así que una tabla creada por
-- el rol dueño (que es quien corre las migraciones) ya debería quedar accesible para
-- `macha_app`. Esto es cinturón y tirantes: si esa migración corrió ANTES de que existiera
-- el rol —su propio encabezado admite ese caso y lo registra con un NOTICE—, los default
-- privileges nunca se aplicaron, y el síntoma sería `permission denied for table plans` en
-- producción funcionando perfecto en cualquier entorno donde la app conecte con el rol
-- dueño. Ese es el peor tipo de bug: invisible hasta el deploy.
--
-- `plans` NO es un ledger append-only: es catálogo, y el super_admin lo edita desde el
-- panel. Por eso lleva UPDATE y DELETE, a diferencia de `payments` o `credit_transactions`,
-- donde el REVOKE es la garantía de que una corrección sea una fila compensatoria.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'macha_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON plans TO macha_app;
  END IF;
END $$;
