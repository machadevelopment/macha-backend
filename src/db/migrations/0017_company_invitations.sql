-- CU-868kh8pwv: invitaciones de miembros, flujo PROPIO contra `company_users`.
--
-- DECISIÓN DE ARQUITECTURA (Jose, 2026-07-28): NO se usa el sistema de invitaciones de
-- WorkOS. Los roles y permisos de negocio viven en este Postgres, no en el RBAC de
-- WorkOS (PRD §03, CU-868kfv96c). Si el estado "invitado, pendiente de aceptar" viviera
-- en WorkOS y el rol acá, la fuente de verdad quedaría partida en dos sistemas que
-- pueden divergir. WorkOS autentica; no modela la organización ni su membresía.
--
-- ────────────────────────────────────────────────────────────────────────────────────
-- EL TOKEN NO SE GUARDA: SE GUARDA SU HASH
-- ────────────────────────────────────────────────────────────────────────────────────
-- `token_hash` es sha256 del token que viaja en el enlace del correo. La regla no
-- negociable de CLAUDE.md ("no passwords/secrets in the DB") no habla solo de
-- contraseñas: un token de invitación en claro es una credencial que otorga acceso a los
-- datos financieros de una empresa. Quien lea la tabla (un dump, un backup, un staff con
-- acceso a la base) no debe poder usar las invitaciones pendientes. El servidor hashea
-- lo que recibe y compara; el claro solo existe en el correo del invitado.
--
-- ────────────────────────────────────────────────────────────────────────────────────
-- POR QUÉ LA POLÍTICA MIRA TAMBIÉN AL USUARIO, NO SOLO A LA EMPRESA
-- ────────────────────────────────────────────────────────────────────────────────────
-- Es el mismo problema de arranque que 0012 resolvió para `company_users`, y por la
-- misma razón de fondo: quien ACEPTA una invitación todavía NO es miembro de la empresa,
-- así que en su request no hay ningún `app.company_id` que setear — el guard no puede
-- resolverlo, porque resolverlo es justamente lo que la aceptación viene a habilitar.
-- Con una política solo por empresa, aceptar sería imposible: cero filas visibles.
--
-- La visibilidad natural de esta tabla, como la de las membresías, no es "por empresa"
-- sino también "por destinatario". La política admite las dos lecturas legítimas:
--   · por empresa  — `app.company_id`, para que el owner gestione su equipo;
--   · por invitado — el correo de la invitación coincide con el de `app.user_id`.
--
-- La subconsulta a `users` funciona porque `users` no tiene RLS (es la tabla de
-- identidad, no de datos de empresa). `app.user_id` lo setea el servidor con SET LOCAL
-- tras verificar el JWT; no lo aporta el cliente ni un modelo.
--
-- Lo que NO se hace, igual que en 0012: una política de bootstrap del tipo "si no hay
-- GUC, deja leer". Eso convertiría la ausencia de scoping en acceso total sobre la tabla
-- que reparte acceso. El modo de fallo tiene que seguir siendo "no ve nada".
--
-- `nullif(..., '')` en todo: un GUC revertido al cerrar la transacción vale cadena
-- vacía, y `''::uuid` revienta en la siguiente request de esa misma conexión del pool.
--
-- ────────────────────────────────────────────────────────────────────────────────────
-- POR QUÉ NO SE PUEDE INVITAR A UN `owner`
-- ────────────────────────────────────────────────────────────────────────────────────
-- El CHECK excluye 'owner' a propósito. Toda empresa tiene exactamente un owner y
-- transferir la propiedad es una acción explícita, nunca un efecto colateral de mandar
-- un correo (invariantes de `lib/membership-invariants.ts`). Dejar que una invitación
-- cree un segundo owner rompería la invariante desde fuera de la función que la protege.

CREATE TABLE IF NOT EXISTS company_invitations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies (id),
  email text NOT NULL,
  role text NOT NULL,
  token_hash text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  invited_by_user_id uuid NOT NULL REFERENCES users (id),
  expires_at timestamptz NOT NULL,
  accepted_at timestamptz,
  accepted_by_user_id uuid REFERENCES users (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT company_invitations_role_chk CHECK (role IN ('admin', 'member')),
  CONSTRAINT company_invitations_status_chk CHECK (
    status IN ('pending', 'accepted', 'revoked', 'expired')
  )
);

-- El token se busca por su hash en la aceptación, sin conocer la empresa todavía.
CREATE UNIQUE INDEX IF NOT EXISTS company_invitations_token_uq
  ON company_invitations (token_hash);

-- Una sola invitación viva por (empresa, correo). PARCIAL sobre `pending` a propósito:
-- una invitación revocada o ya aceptada no debe impedir volver a invitar a esa persona
-- —alguien se va del equipo y vuelve— pero dos pendientes a la vez sí son un error, y el
-- árbitro tiene que ser el índice y no una comprobación en la app, que se puede colar
-- entre dos peticiones simultáneas. `lower(email)` porque el correo no distingue
-- mayúsculas para este propósito y "Ana@x.com" no es una segunda persona.
CREATE UNIQUE INDEX IF NOT EXISTS company_invitations_pending_uq
  ON company_invitations (company_id, lower(email))
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS company_invitations_company_status_idx
  ON company_invitations (company_id, status);

ALTER TABLE company_invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE company_invitations FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS company_invitations_tenant_isolation ON company_invitations;

CREATE POLICY company_invitations_tenant_isolation ON company_invitations
  USING (
    company_id = nullif(current_setting('app.company_id', true), '')::uuid
    OR lower(email) = (
      SELECT lower(u.email)
      FROM users u
      WHERE u.id = nullif(current_setting('app.user_id', true), '')::uuid
    )
    OR nullif(current_setting('app.cross_tenant', true), '') = 'on'
  );

-- No es un ledger append-only: aceptar y revocar cambian el estado de la fila.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'macha_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON company_invitations TO macha_app;
  END IF;
END $$;

-- CU-868kh8pwv: el correo de invitación se registra en `notifications` como cualquier
-- otro envío, y su CHECK de 0003 solo admitía 'report' y 'alert'. Sin esto, encolar la
-- invitación revienta al insertar la notificación — con la invitación ya creada y el
-- correo sin salir, que es el peor de los dos estados posibles.
DO $$
BEGIN
  ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_kind_chk;
  ALTER TABLE notifications
    ADD CONSTRAINT notifications_kind_chk CHECK (kind IN ('report', 'alert', 'invitation'));
END $$;
