-- CU-868kj3utc (urgente). Dos defectos que hacían imposible correr la app con el rol
-- `macha_app` — es decir, que rompían el despliegue documentado en 0010. Los dos los
-- destapó la infra de test de integración (CU-868kh8zbj) al conectar con ese rol.
--
-- ════════════════════════════════════════════════════════════════════════════════════
-- (A) `company_users` no se podía leer para RESOLVER la empresa
-- ════════════════════════════════════════════════════════════════════════════════════
-- La política de 0002 es `company_id = current_setting('app.company_id', true)::uuid`.
-- Pero `company_users` es justamente la tabla donde el guard DESCUBRE a qué empresa
-- pertenece el usuario: se consulta ANTES de que exista un `app.company_id` que setear.
-- Con el GUC sin setear la comparación da NULL, no vuelve ninguna fila y el guard
-- responde `403 No active company membership` a TODO request autenticado.
--
-- Por qué NO sirve una función `SECURITY DEFINER` (la salida que proponía el ticket):
-- hace que la función corra como su dueño, pero desde 0010 el dueño TAMBIÉN está sujeto
-- a RLS (`FORCE`), así que seguiría viendo cero filas. Solo funcionaría con un rol
-- adicional con `BYPASSRLS`, atributo que exige superusuario y que Railway no concede.
--
-- La salida: `company_users` no es una tabla de datos de empresa, es la de membresías,
-- y su regla natural de visibilidad no es "por empresa" sino "por usuario". La política
-- admite ahora las dos lecturas legítimas — por empresa (`app.company_id`, lo de
-- siempre) y por usuario (`app.user_id`, sus propias membresías). `app.user_id` lo
-- setea el servidor con SET LOCAL tras verificar el JWT y resolver `users` (tabla sin
-- RLS); no lo aporta el cliente ni un modelo, igual que `app.company_id`.
--
-- Lo que NO se hace, a propósito: una política de bootstrap del tipo "si el GUC no está
-- seteado, deja leer". Eso convertiría la ausencia de scoping en acceso total sobre la
-- tabla que decide quién ve qué. El modo de fallo debe seguir siendo "no ve nada".
--
-- ════════════════════════════════════════════════════════════════════════════════════
-- (B) El GUC revertido vale '' (cadena vacía), y ''::uuid es un ERROR
-- ════════════════════════════════════════════════════════════════════════════════════
-- Gotcha de Postgres verificado contra una instancia real: `current_setting(x, true)`
-- devuelve NULL solo mientras el GUC NUNCA se ha seteado en esa sesión. En cuanto una
-- transacción hace `SET LOCAL app.company_id = ...` y termina, el parámetro no vuelve a
-- "inexistente": vuelve a su valor de sesión, que para un GUC personalizado sin valor
-- previo es la CADENA VACÍA. A partir de ahí `current_setting(...)::uuid` no da NULL:
-- lanza `invalid input syntax for type uuid: ""`.
--
-- Como las conexiones vienen de un pool y se reutilizan entre requests, esto significa
-- que la PRIMERA request de cada conexión funcionaba y la SEGUNDA fallaba con un 500 —
-- en cualquier tabla con RLS, no solo en `company_users`. Estaba latente desde 0002 y
-- no se notaba porque nadie había ejecutado dos requests seguidas contra un Postgres
-- real con un rol sujeto a RLS (en local el rol dueño es superusuario y se la salta).
--
-- Arreglo: `nullif(current_setting(...), '')` en TODAS las políticas, para que el GUC
-- revertido se comporte igual que el nunca seteado. Por eso se recrean todas las
-- políticas de 0002 y 0009, y también las de las particiones por empresa ya existentes
-- (`transactions_*`/`invoices_*`/`bills_*`, creadas por lib/tenant-provisioning.ts, que
-- se actualiza en el mismo cambio para las nuevas).

-- ---- Políticas de las tablas normales (lista de 0002 + 0009, menos company_users) ----
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'transactions','invoices','bills','products','stores','fx_rates',
    'documents','staging_rows','metric_rollups','chats','chat_messages','chat_segments',
    'ai_usage_events','credit_transactions','insight_requests','reports','report_versions',
    'alert_rules','alert_events','notifications','subscriptions','payments'
  ] LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I;', t || '_tenant_isolation', t);
    EXECUTE format($f$
      CREATE POLICY %I ON %I
      USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid);
    $f$, t || '_tenant_isolation', t);
  END LOOP;
END $$;

-- ---- company_users: además, el usuario puede leer SUS propias membresías (A) ----
DROP POLICY IF EXISTS company_users_tenant_isolation ON company_users;

CREATE POLICY company_users_tenant_isolation ON company_users
  USING (
    company_id = nullif(current_setting('app.company_id', true), '')::uuid
    OR user_id = nullif(current_setting('app.user_id', true), '')::uuid
  );

-- ---- Particiones por empresa ya aprovisionadas ----
-- Sus políticas se crean fuera de las migraciones (en el onboarding de cada empresa),
-- así que hay que recorrerlas: una partición con la política vieja seguiría reventando
-- con `""::uuid` en la segunda request de cada conexión.
DO $$
DECLARE part record;
BEGIN
  FOR part IN
    SELECT c.relname AS name
    FROM pg_class c
    JOIN pg_inherits i ON i.inhrelid = c.oid
    JOIN pg_class p ON p.oid = i.inhparent
    WHERE p.relname IN ('transactions', 'invoices', 'bills')
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I;', part.name || '_tenant_isolation', part.name);
    EXECUTE format($f$
      CREATE POLICY %I ON %I
      USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid);
    $f$, part.name || '_tenant_isolation', part.name);
  END LOOP;
END $$;
