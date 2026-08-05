-- CU-868kjc4af: el panel admin necesita ver TODAS las empresas, y con el rol macha_app
-- no veía ninguna.
--
-- EL PROBLEMA. `admin.guard.ts` y los siete módulos `/admin/*` consultan con el pool
-- global y sin ningún GUC — a propósito, porque staff necesita visibilidad
-- cross-company. Eso funcionaba mientras la app conectaba con el rol dueño. Desde 0010
-- (`FORCE ROW LEVEL SECURITY`) el dueño también está sujeto a RLS, y `macha_app` no
-- tiene `BYPASSRLS`, así que sin `app.company_id` la política no hace match con nada.
--
-- Verificado contra una instancia real, conectando como macha_app sin GUC:
--   documents 0 · staging_rows 0 · ai_usage_events 0 · subscriptions 0 · alert_rules 0
--   (companies, users y staff sí se ven: no tienen RLS)
--
-- Y no daba error: devolvía 200 con listas vacías. El backoffice parecía funcionar y
-- mostraba el costo de IA en cero, cero uploads y cero filas marcadas.
--
-- ALTERNATIVAS DESCARTADAS.
--   * Rol dedicado con `BYPASSRLS`: es lo más limpio conceptualmente, pero conceder ese
--     atributo exige superusuario y Railway no lo da al rol provisionado.
--   * Scopear el admin por empresa: rompe la razón de ser del panel y no aplica a
--     `/admin/ai-cost`, que es una agregación cross-company por definición.
--
-- LA SALIDA: un GUC de escape, `app.cross_tenant`, que solo setea `admin.guard` después
-- de verificar la fila en `staff`. Es el mismo mecanismo que ya usan `app.company_id` y
-- `app.user_id`: un valor que solo puede poner código del servidor sobre la conexión
-- reservada del request. La cadena de guards de tenant NUNCA lo setea — hay un test que
-- lo fija (`tests/integration/admin-cross-tenant.test.ts`).
--
-- POR QUÉ SE APLICA A TODAS LAS TABLAS DE INQUILINO Y NO SOLO A LAS QUE EL ADMIN LEE HOY.
-- Abrir solo las nueve que consultan los módulos actuales parece más prudente, pero
-- reproduce exactamente el fallo que estamos arreglando: el próximo endpoint admin
-- contra una tabla no listada volvería a devolver cero filas EN SILENCIO. La protección
-- real es quién puede setear el GUC, no la lista de tablas, así que la lista se mantiene
-- igual a la de la política de inquilino y el control vive en el guard.
--
-- Las particiones por empresa (`transactions_*` etc.) no se tocan: sus políticas solo
-- aplican al acceso directo por nombre de partición, y la app siempre consulta por la
-- tabla padre, cuya política sí queda actualizada abajo.

-- ---- Tablas con política por empresa: se añade la vía de staff ----
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
      USING (
        company_id = nullif(current_setting('app.company_id', true), '')::uuid
        OR nullif(current_setting('app.cross_tenant', true), '') = 'on'
      );
    $f$, t || '_tenant_isolation', t);
  END LOOP;
END $$;

-- ---- company_users: conserva además la lectura por usuario de 0012 ----
DROP POLICY IF EXISTS company_users_tenant_isolation ON company_users;

CREATE POLICY company_users_tenant_isolation ON company_users
  USING (
    company_id = nullif(current_setting('app.company_id', true), '')::uuid
    OR user_id = nullif(current_setting('app.user_id', true), '')::uuid
    OR nullif(current_setting('app.cross_tenant', true), '') = 'on'
  );
