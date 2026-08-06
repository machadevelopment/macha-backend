-- Inventario, categoría de producto y unidades en el ledger.
--
-- Las tres pantallas que faltaban del prototipo MVP Macha (Analítica, Ventas por producto
-- e Inventario) se apoyaban en datos que no existían en ninguna parte del sistema:
-- ninguna tabla guardaba cuántas unidades se vendieron, a qué familia pertenece un
-- producto, ni qué hay en bodega. Sin esto, "unidades vendidas", "ticket promedio",
-- "margen por producto" y la pantalla entera de Inventario no son calculables — no es que
-- salgan en cero, es que no hay de dónde sacarlas.
--
-- Idempotente como todas: migrate.ts aplica CADA archivo en CADA invocación.

-- ---------------------------------------------------------------------------
-- 1) products.category — agrupador para "ventas por categoría".
-- ---------------------------------------------------------------------------
-- Nullable sin default: un producto nace cuando la ingesta lo nombra, y en esa fila puede
-- no haber nada que diga a qué familia pertenece. Un default 'sin categoría' se vería
-- idéntico a una categoría real en la gráfica de participación.
ALTER TABLE products ADD COLUMN IF NOT EXISTS category text;

CREATE INDEX IF NOT EXISTS products_company_category_idx ON products (company_id, category);

-- ---------------------------------------------------------------------------
-- 2) transactions.quantity — unidades del movimiento.
-- ---------------------------------------------------------------------------
-- ADD COLUMN sobre el padre particionado se propaga a todas las particiones; es
-- instantáneo porque la columna es nullable y sin default (no reescribe las tablas).
--
-- numeric(18,3) y no integer: una PYME guatemalteca vende por libra, quintal o metro
-- tanto como por unidad, y un entero obligaría a redondear el dato del cliente en la
-- ingesta. NULL significa "esta fila no expresa cantidades" (alquiler, comisión, un
-- total) y es distinto de 0 — las queries de unidades filtran IS NOT NULL por eso.
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS quantity numeric(18, 3);

-- Solo tiene sentido positiva. NOT VALID para no escanear el histórico: la restricción
-- rige de inmediato para filas nuevas, que es lo único que puede traer el dato (ninguna
-- fila anterior a esta migración tiene quantity).
DO $$ BEGIN
  ALTER TABLE transactions DROP CONSTRAINT IF EXISTS transactions_quantity_chk;
  ALTER TABLE transactions ADD CONSTRAINT transactions_quantity_chk
    CHECK (quantity IS NULL OR quantity > 0) NOT VALID;
END $$;

-- Cubre el ranking de productos por unidades sin tocar filas sin producto.
CREATE INDEX IF NOT EXISTS transactions_company_product_date_idx
  ON transactions (company_id, product_id, date)
  WHERE product_id IS NOT NULL AND deleted_at IS NULL;

-- ---------------------------------------------------------------------------
-- 3) inventory_items — existencias por SKU.
-- ---------------------------------------------------------------------------
-- NO particionada, a diferencia de transactions/invoices/bills: el inventario de una PYME
-- es un catálogo de cientos de SKUs, no el volumen del producto. Se parece a
-- products/stores (tabla plana + RLS) y particionarla solo costaría dos particiones más
-- por empresa en cada aprovisionamiento, a cambio de nada.
CREATE TABLE IF NOT EXISTS inventory_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies (id),
  product_id uuid,
  sku text NOT NULL,
  name text NOT NULL,
  location text,
  quantity_on_hand numeric(18, 3) NOT NULL DEFAULT 0,
  reorder_point numeric(18, 3) NOT NULL DEFAULT 0,
  -- Dinero con el trato de siempre (CLAUDE.md): original + moneda, convertido a la base
  -- de la empresa, y el tipo de cambio congelado en la fila. Valorizar el inventario es
  -- una cifra financiera más; sin esto el valor total sumaría quetzales con dólares.
  unit_cost_original numeric(18, 2) NOT NULL DEFAULT 0,
  unit_cost_currency text NOT NULL,
  unit_cost_base numeric(18, 2) NOT NULL DEFAULT 0,
  fx_rate numeric(18, 8) NOT NULL DEFAULT 1,
  fx_rate_date date NOT NULL,
  supplier text,
  last_restock_date date,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

DO $$ BEGIN
  ALTER TABLE inventory_items DROP CONSTRAINT IF EXISTS inventory_items_currency_chk;
  ALTER TABLE inventory_items ADD CONSTRAINT inventory_items_currency_chk
    CHECK (unit_cost_currency IN ('GTQ', 'USD'));

  -- El stock puede quedar negativo por un ajuste de conteo mal hecho, pero no por diseño;
  -- se deja pasar y la pantalla lo señala, en vez de reventar la carga del movimiento.
  ALTER TABLE inventory_items DROP CONSTRAINT IF EXISTS inventory_items_reorder_chk;
  ALTER TABLE inventory_items ADD CONSTRAINT inventory_items_reorder_chk
    CHECK (reorder_point >= 0);
END $$;

CREATE INDEX IF NOT EXISTS inventory_items_company_idx ON inventory_items (company_id);

-- Destino de la FK compuesta desde inventory_movements.
CREATE UNIQUE INDEX IF NOT EXISTS inventory_items_company_id_uq
  ON inventory_items (company_id, id);

-- SKU único por empresa, sin distinguir mayúsculas y sin contar los dados de baja: un SKU
-- descontinuado no debe bloquear el alta de uno nuevo con el mismo código. drizzle-kit no
-- emite ni lower() ni WHERE, por eso va a mano.
CREATE UNIQUE INDEX IF NOT EXISTS inventory_items_company_sku_uq
  ON inventory_items (company_id, lower(sku))
  WHERE deleted_at IS NULL;

-- FK compuesta al catálogo de productos: incluye company_id para que una referencia
-- cross-tenant sea imposible de escribir.
DO $$ BEGIN
  ALTER TABLE inventory_items DROP CONSTRAINT IF EXISTS inventory_items_product_fk;
  ALTER TABLE inventory_items ADD CONSTRAINT inventory_items_product_fk
    FOREIGN KEY (company_id, product_id) REFERENCES products (company_id, id);
END $$;

-- ---------------------------------------------------------------------------
-- 4) inventory_movements — ledger append-only de entradas/salidas/ajustes.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS inventory_movements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies (id),
  item_id uuid NOT NULL,
  movement_type text NOT NULL,
  quantity numeric(18, 3) NOT NULL,
  quantity_after numeric(18, 3) NOT NULL,
  reason text,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

DO $$ BEGIN
  ALTER TABLE inventory_movements DROP CONSTRAINT IF EXISTS inventory_movements_type_chk;
  ALTER TABLE inventory_movements ADD CONSTRAINT inventory_movements_type_chk
    CHECK (movement_type IN ('in', 'out', 'adjustment'));

  -- El signo lo pone movement_type, no la cantidad: guardar ambos permite que se
  -- contradigan y obliga a decidir cuál gana en cada lectura. La excepción es
  -- `adjustment`, donde el negativo SÍ significa algo distinto ("faltan 3" en un conteo
  -- físico) y forzarlo a 'out' mentiría — no salió mercadería, se corrigió el libro.
  ALTER TABLE inventory_movements DROP CONSTRAINT IF EXISTS inventory_movements_quantity_chk;
  ALTER TABLE inventory_movements ADD CONSTRAINT inventory_movements_quantity_chk
    CHECK ((movement_type = 'adjustment' AND quantity <> 0) OR (movement_type IN ('in','out') AND quantity > 0));
END $$;

CREATE INDEX IF NOT EXISTS inventory_movements_company_idx ON inventory_movements (company_id);

-- El historial se lee siempre por item y en orden cronológico inverso.
CREATE INDEX IF NOT EXISTS inventory_movements_company_item_idx
  ON inventory_movements (company_id, item_id, occurred_at DESC);

DO $$ BEGIN
  ALTER TABLE inventory_movements DROP CONSTRAINT IF EXISTS inventory_movements_item_fk;
  ALTER TABLE inventory_movements ADD CONSTRAINT inventory_movements_item_fk
    FOREIGN KEY (company_id, item_id) REFERENCES inventory_items (company_id, id);
END $$;

-- ---------------------------------------------------------------------------
-- 5) RLS + privilegios para las dos tablas nuevas.
-- ---------------------------------------------------------------------------
-- Mismo patrón que 0002 + 0010: ENABLE no basta porque el dueño lo ignora (verificado
-- contra una instancia real), así que va también FORCE. Y las políticas usan
-- nullif(current_setting(...),'') porque un GUC revertido al cerrar la transacción vale
-- cadena vacía, no NULL, y ''::uuid revienta la siguiente request de esa conexión (0012).
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['inventory_items', 'inventory_movements'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY;', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY;', t);
    BEGIN
      EXECUTE format($f$
        CREATE POLICY %I_tenant_isolation ON %I
        USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid);
      $f$, t, t);
    EXCEPTION WHEN duplicate_object THEN NULL;
    END;
  END LOOP;
END $$;

-- inventory_movements es ledger append-only (CLAUDE.md): una corrección es un movimiento
-- de ajuste, no una edición del anterior. El REVOKE FROM PUBLIC no alcanza al dueño y no
-- hay "FORCE" para privilegios como sí lo hay para RLS — la garantía real es el REVOKE a
-- macha_app, y solo aplica si la app conecta con ese rol (APP_DATABASE_URL).
REVOKE UPDATE, DELETE ON inventory_movements FROM PUBLIC;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'macha_app') THEN
    RAISE NOTICE 'macha_app no existe todavía — se omite el bloque GRANT/REVOKE de inventario (ver cabecera de 0010).';
    RETURN;
  END IF;

  -- ALTER DEFAULT PRIVILEGES de 0010 ya cubre las tablas nuevas creadas por el dueño,
  -- pero se otorga explícitamente: 0010 pudo haber corrido antes de que macha_app
  -- existiera (su propio bloque se salta entero en ese caso) y entonces el default
  -- privilege nunca se registró.
  EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON inventory_items TO macha_app';
  EXECUTE 'GRANT SELECT, INSERT ON inventory_movements TO macha_app';
  EXECUTE 'REVOKE UPDATE, DELETE ON inventory_movements FROM macha_app';
END $$;
