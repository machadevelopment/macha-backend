-- Solicitudes de demo desde la landing (pedido de Jose, 2026-08-21).
--
-- Jose, sobre el CTA de la landing: "igual creo que debería ir un form básico, para que pongan
-- como datos básicos". Hasta ahora el único camino de conversión era un `mailto:`.
--
-- ═══ POR QUÉ NO ALCANZABA CON MANDAR UN CORREO ═══
--
-- Un formulario que solo notifica por correo PIERDE la solicitud si el correo no sale, y sale sin
-- que nadie se entere. En este proyecto eso no es hipotético: ya pasó con las invitaciones
-- (CU-868krkndr, `RESEND_FROM_EMAIL=onboarding@resend.dev` entregaba solo al dueño de la cuenta y
-- el flujo entero decía "enviado"). Y hoy no se puede afirmar que `macha.finance` esté verificado
-- como dominio de envío en Resend: `email-sender-check.ts` dice explícitamente que NO lo comprueba.
--
-- Entonces la solicitud se GUARDA primero y el correo es un aviso encima. Si el aviso falla, el
-- lead sigue estando y el panel lo muestra. Al revés se pierde un cliente potencial en silencio,
-- que es peor que cualquier fallo visible.
--
-- ═══ APPEND-ONLY, Y ESO INCLUYE NO TENER ESTADO "CONTACTADO" ═══
--
-- Lo que esta tabla guarda es un HECHO: alguien escribió estos datos en este momento. Permitir
-- UPDATE haría editable lo que la persona realmente escribió, y entonces la fila deja de ser
-- evidencia de nada — un correo mal tipeado "corregido" a mano es indistinguible de uno inventado.
--
-- Consecuencia honesta y NO resuelta acá: no hay forma de marcar una solicitud como ya atendida.
-- El panel lista de más nueva a más vieja con su fecha. Agregar seguimiento es una decisión de
-- producto aparte, y cuando se tome el camino es una SEGUNDA tabla de eventos, no un UPDATE sobre
-- esta.
--
-- ═══ NO ES UNA TABLA DE NEGOCIO: SIN `company_id` Y SIN RLS ═══
--
-- Quien llena el formulario todavía no es cliente de nadie: no existe una empresa a la que scopear
-- la fila. Es catálogo de plataforma, igual que `industry_starter_templates` y `plans`.
--
-- Ponerle RLS por simetría sería PEOR que no ponérselo: la política necesitaría un `app.company_id`
-- que el endpoint público no tiene por qué conocer —ni tiene—, y el resultado sería un INSERT que
-- falla o una tabla que se lee vacía desde el panel. Lo que la protege es el guard: el POST es
-- público a propósito y solo escribe; leerla exige `/admin/*`, o sea `staff`.
--
-- ⚠️ ESE GUARD NO ES DEFENSA EN PROFUNDIDAD ACÁ, ES LA ÚNICA DEFENSA. Igual que en
-- `industry_starter_templates`. Vale saberlo antes de agregar una ruta que la lea.
--
-- Idempotente: `migrate.ts` lleva registro por sha256, pero editar este archivo lo reaplica.

-- ---------------------------------------------------------------------------
-- 1) La tabla.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS demo_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Lo que Jose llamó "datos básicos". Nombre, empresa y correo son lo mínimo para devolver la
  -- llamada; teléfono y mensaje son opcionales porque exigirlos cuesta conversiones y no aportan
  -- a poder responder.
  name text NOT NULL,
  company_name text NOT NULL,
  email text NOT NULL,
  phone text,
  message text,

  -- El idioma en que se llenó el formulario. Sirve para responder en el idioma correcto, que es
  -- información que se pierde para siempre si no se guarda en el momento.
  locale text NOT NULL DEFAULT 'es',

  -- De dónde vino. Hoy siempre 'landing'; existe para no tener que migrar cuando haya un segundo
  -- formulario (un anuncio, un evento) y haga falta saber qué convierte.
  source text NOT NULL DEFAULT 'landing',

  -- ═══ SE GUARDA UN HASH DE LA IP, NUNCA LA IP ═══
  --
  -- Para lo único que la IP se necesita es CONTAR: "¿cuántas solicitudes vinieron del mismo lugar
  -- en las últimas 24 horas?". Un hash con sal del servidor responde eso exactamente igual y no
  -- deja un dato personal guardado indefinidamente en una tabla que lee todo el staff.
  --
  -- Y no es solo privacidad: si la tabla se filtra, un hash sin la sal no se puede revertir a una
  -- IP, mientras que una columna de IPs es un mapa de quién visitó el sitio.
  ip_hash text NOT NULL,

  created_at timestamptz NOT NULL DEFAULT now(),

  -- Los CHECK son el último freno, no el primero: la validación de verdad vive en el esquema
  -- TypeBox del endpoint. Están porque un INSERT desde una consola o un script futuro no pasa por
  -- ese esquema, y esta tabla no se puede limpiar (append-only).
  CONSTRAINT demo_requests_name_ck CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  CONSTRAINT demo_requests_company_ck CHECK (length(btrim(company_name)) BETWEEN 1 AND 160),
  -- Deliberadamente laxo: `%_@_%` acepta cualquier cosa con arroba y algo a cada lado. Un regex
  -- estricto de correo rechaza direcciones válidas raras y su único efecto sería perder un lead
  -- real. Que el correo exista lo dice el intento de responderle, no una expresión regular.
  CONSTRAINT demo_requests_email_ck CHECK (email LIKE '%_@_%' AND length(email) <= 254),
  CONSTRAINT demo_requests_phone_ck CHECK (phone IS NULL OR length(phone) <= 40),
  CONSTRAINT demo_requests_message_ck CHECK (message IS NULL OR length(message) <= 2000),
  CONSTRAINT demo_requests_locale_ck CHECK (locale IN ('es', 'en'))
);

-- ---------------------------------------------------------------------------
-- 2) Índices.
-- ---------------------------------------------------------------------------
-- La consulta del límite por origen, que corre en CADA envío: cuántas del mismo hash desde tal
-- fecha. Sin este índice, un endpoint PÚBLICO hace un scan completo por request — o sea que el
-- freno anti-abuso sería él mismo el vector de abuso.
CREATE INDEX IF NOT EXISTS demo_requests_origen_idx
  ON demo_requests (ip_hash, created_at DESC);

-- El listado del panel.
CREATE INDEX IF NOT EXISTS demo_requests_recientes_idx
  ON demo_requests (created_at DESC);

-- ---------------------------------------------------------------------------
-- 3) Permisos del rol de aplicación.
-- ---------------------------------------------------------------------------
-- SELECT e INSERT, nunca UPDATE ni DELETE: es lo que hace REAL el append-only. Sin el REVOKE la
-- regla sería una convención que el próximo `db.update()` rompe sin avisar.
--
-- Solo vale si la app conecta como `macha_app`: el DUEÑO de la tabla conserva UPDATE y DELETE
-- implícitos pase lo que pase (no existe un "FORCE" para privilegios como sí lo hay para RLS).
-- Ver migración 0010.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'macha_app') THEN
    GRANT SELECT, INSERT ON demo_requests TO macha_app;
    REVOKE UPDATE, DELETE ON demo_requests FROM macha_app;
  END IF;
END $$;

COMMENT ON TABLE demo_requests IS
  'Solicitudes de demo enviadas desde la landing publica (Jose 2026-08-21). Append-only: la fila es el hecho de que alguien escribio esos datos, no un registro editable, y por eso no hay estado "contactado". Sin company_id ni RLS: quien la llena todavia no es cliente de ninguna empresa. Se guarda un hash con sal de la IP, nunca la IP.';
