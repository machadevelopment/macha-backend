import { Elysia, t } from 'elysia';
import { and, eq, sql as rawSql } from 'drizzle-orm';
import { tenantDerive } from '@/guards/tenant.derive';
import { identityDerive } from '@/guards/identity.derive';
import { assertClientCapability } from '@/guards/require-capability';
import { enforceTokenBucket } from '@/lib/rate-limit';
import { companyUsers, companyInvitations, companies, users } from '@/db/schema';
import { dejariaSinOwner, MENSAJE_SIN_OWNER } from '@/lib/membership-invariants';
import {
  generateInvitationToken,
  hashInvitationToken,
  invitationExpiry,
  rejectAcceptance,
  INVITATION_REJECTION_MESSAGE,
} from '@/lib/invitations';
import { sendInvitationEmail } from '@/lib/email';
import { invitationAcceptUrl } from '@/lib/app-urls';

/**
 * CU-868kh8pwv — gestión de miembros AUTOSERVICIO. Decisión de Jose (2026-07-28).
 *
 * Por qué entra al MVP aunque el registro autoservicio (Módulo 8) siga diferido:
 * registrarse desde la landing e invitar a un colega son cosas distintas. Lo primero
 * crea empresa y cobra; lo segundo ocurre dentro de una cuenta que YA existe y YA paga.
 * Si al dueño le damos una cuenta pero no puede agregar a su contadora sin escribirle a
 * soporte, el producto se siente roto desde el primer día.
 *
 * FLUJO DE INVITACIÓN PROPIO, NO EL DE WORKOS (decisión de arquitectura, misma nota de
 * Jose): los roles de negocio viven en este Postgres (PRD §03). Con las invitaciones de
 * WorkOS, el estado "invitado, pendiente de aceptar" viviría allá y el rol acá — dos
 * fuentes de verdad que pueden divergir. WorkOS autentica; no modela la organización.
 *
 * LAS TRES INVARIANTES (PRD §8, `lib/membership-invariants.ts`) se respetan aquí:
 *   1. Toda empresa tiene exactamente un owner  -> `dejariaSinOwner` antes de escribir.
 *   2. Transferir la propiedad es explícito     -> no se puede invitar ni promover a
 *      'owner' desde estos endpoints (ver PATCH y el CHECK de la migración 0017).
 *   3. El owner no puede autodegradarse ni eliminarse si es el único -> (1) lo cubre,
 *      y además se bloquea explícitamente el auto-borrado para dar un mensaje claro.
 *
 * La aceptación NO va en el guard de tenant: quien acepta todavía no es miembro, así que
 * no hay `company_id` que resolver. Va bajo `identityDerive`, que solo exige identidad.
 */

const ROLE_ASIGNABLE = t.Union([t.Literal('admin'), t.Literal('member')]);

export const members = new Elysia({ prefix: '/members' })
  .use(tenantDerive)
  .get('/', async ({ companyId, role, set, db }) => {
    assertClientCapability(role, 'manage_members', set);
    const limited = await enforceTokenBucket('read', companyId, set, 'GET /members');
    if (limited) return limited;

    return db
      .select({
        userId: companyUsers.userId,
        email: users.email,
        name: users.name,
        role: companyUsers.role,
        status: companyUsers.status,
        receivesReports: companyUsers.receivesReports,
      })
      .from(companyUsers)
      .innerJoin(users, eq(users.id, companyUsers.userId))
      .where(eq(companyUsers.companyId, companyId));
  })

  .get('/invitations', async ({ companyId, role, set, db }) => {
    assertClientCapability(role, 'manage_members', set);
    // Nunca se devuelve `token_hash`: no sirve para nada al cliente y es el material
    // con el que se valida la aceptación.
    return db
      .select({
        id: companyInvitations.id,
        email: companyInvitations.email,
        role: companyInvitations.role,
        status: companyInvitations.status,
        expiresAt: companyInvitations.expiresAt,
        createdAt: companyInvitations.createdAt,
      })
      .from(companyInvitations)
      .where(
        and(eq(companyInvitations.companyId, companyId), eq(companyInvitations.status, 'pending')),
      );
  })

  .post(
    '/invitations',
    async ({ companyId, userId, role, body, set, db }) => {
      assertClientCapability(role, 'manage_members', set);
      // Bucket de escritura sobre el de lectura: invitar manda correo, y sin límite un
      // owner (o una sesión robada) puede usar la app como emisor de spam.
      const limited = await enforceTokenBucket('read', companyId, set, 'POST /members/invitations');
      if (limited) return limited;

      const email = body.email.trim().toLowerCase();

      // Ya es miembro: invitarlo otra vez no haría nada útil y el correo confundiría.
      const [yaMiembro] = await db
        .select({ userId: companyUsers.userId })
        .from(companyUsers)
        .innerJoin(users, eq(users.id, companyUsers.userId))
        .where(
          and(eq(companyUsers.companyId, companyId), rawSql`lower(${users.email}) = ${email}`),
        );
      if (yaMiembro) {
        set.status = 409;
        return { error: 'Esa persona ya es miembro de la empresa.' };
      }

      const token = generateInvitationToken();
      const [company] = await db
        .select({ name: companies.name, locale: companies.locale })
        .from(companies)
        .where(eq(companies.id, companyId));
      const [invitador] = await db
        .select({ email: users.email })
        .from(users)
        .where(eq(users.id, userId));

      // El índice parcial UNIQUE (company_id, lower(email)) WHERE status='pending' es el
      // árbitro de "una sola invitación viva por persona". Se deja fallar y se traduce,
      // en vez de consultar antes: entre la consulta y el insert caben dos peticiones.
      let invitation;
      try {
        [invitation] = await db
          .insert(companyInvitations)
          .values({
            companyId,
            email,
            role: body.role,
            tokenHash: hashInvitationToken(token),
            invitedByUserId: userId,
            expiresAt: invitationExpiry(new Date()),
          })
          .returning({ id: companyInvitations.id });
      } catch (err) {
        if ((err as { code?: string }).code === '23505') {
          set.status = 409;
          return { error: 'Ya hay una invitación pendiente para ese correo.' };
        }
        throw err;
      }

      await sendInvitationEmail({
        companyId,
        locale: company?.locale ?? 'es',
        invitationId: invitation!.id,
        companyName: company?.name ?? 'tu empresa',
        recipientEmail: email,
        invitedByEmail: invitador?.email ?? 'Un administrador',
        acceptUrl: invitationAcceptUrl(token),
      });

      set.status = 201;
      // El token NO vuelve en la respuesta: su único canal legítimo es el correo del
      // invitado. Devolverlo dejaría que quien invita entre en nombre del invitado.
      return { id: invitation!.id, email, role: body.role };
    },
    { body: t.Object({ email: t.String({ format: 'email' }), role: ROLE_ASIGNABLE }) },
  )

  .delete('/invitations/:id', async ({ companyId, role, params, set, db }) => {
    assertClientCapability(role, 'manage_members', set);
    const [revocada] = await db
      .update(companyInvitations)
      .set({ status: 'revoked', updatedAt: new Date() })
      .where(
        and(
          eq(companyInvitations.id, params.id),
          eq(companyInvitations.companyId, companyId),
          eq(companyInvitations.status, 'pending'),
        ),
      )
      .returning({ id: companyInvitations.id });

    if (!revocada) {
      set.status = 404;
      return { error: 'No hay una invitación pendiente con ese id.' };
    }
    return { revoked: true };
  })

  .patch(
    '/:userId',
    async ({ companyId, userId: actorId, role, params, body, set, db }) => {
      assertClientCapability(role, 'change_roles', set);

      if (params.userId === actorId) {
        // Invariante 3, con mensaje propio: el genérico de `dejariaSinOwner` no
        // explicaría por qué te estás bloqueando a vos mismo.
        set.status = 409;
        return { error: 'No puedes cambiar tu propio rol. Pide a otro owner que lo haga.' };
      }

      const [actual] = await db
        .select({ role: companyUsers.role, status: companyUsers.status })
        .from(companyUsers)
        .where(and(eq(companyUsers.companyId, companyId), eq(companyUsers.userId, params.userId)));
      if (!actual) {
        set.status = 404;
        return { error: 'Esa persona no es miembro de la empresa.' };
      }

      // Invariante 2: el rol 'owner' no se alcanza por aquí, ni de entrada (el body no
      // lo admite) ni de salida (degradar al owner es parte de una transferencia, que es
      // una acción explícita y aún no existe como endpoint de cliente).
      if (actual.role === 'owner') {
        set.status = 409;
        return {
          error:
            'Cambiar el rol del owner es parte de una transferencia de propiedad, que es una acción explícita aparte.',
        };
      }

      if (
        await dejariaSinOwner(db, {
          companyId,
          userId: params.userId,
          nextRole: body.role,
          nextStatus: actual.status,
        })
      ) {
        set.status = 409;
        return { error: MENSAJE_SIN_OWNER };
      }

      await db
        .update(companyUsers)
        .set({ role: body.role, updatedAt: new Date() })
        .where(and(eq(companyUsers.companyId, companyId), eq(companyUsers.userId, params.userId)));
      return { userId: params.userId, role: body.role };
    },
    { body: t.Object({ role: ROLE_ASIGNABLE }) },
  )

  .delete('/:userId', async ({ companyId, userId: actorId, role, params, set, db }) => {
    assertClientCapability(role, 'manage_members', set);

    if (params.userId === actorId) {
      set.status = 409;
      return { error: 'No puedes quitarte a ti mismo de la empresa.' };
    }

    const [actual] = await db
      .select({ role: companyUsers.role, status: companyUsers.status })
      .from(companyUsers)
      .where(and(eq(companyUsers.companyId, companyId), eq(companyUsers.userId, params.userId)));
    if (!actual) {
      set.status = 404;
      return { error: 'Esa persona no es miembro de la empresa.' };
    }

    if (
      await dejariaSinOwner(db, {
        companyId,
        userId: params.userId,
        nextRole: actual.role,
        nextStatus: 'revoked',
      })
    ) {
      set.status = 409;
      return { error: MENSAJE_SIN_OWNER };
    }

    // `revoked`, no DELETE: la membresía es la trazabilidad de quién tuvo acceso a datos
    // financieros y cuándo. Borrar la fila también rompería las FK de lo que esa persona
    // subió o generó.
    await db
      .update(companyUsers)
      .set({ status: 'revoked', updatedAt: new Date() })
      .where(and(eq(companyUsers.companyId, companyId), eq(companyUsers.userId, params.userId)));
    return { userId: params.userId, removed: true };
  });

/**
 * Aceptación — FUERA del guard de tenant, a propósito (ver cabecera). Quien acepta
 * todavía no tiene membresía, así que `tenantDerive` le respondería 403 antes de leer
 * nada. `identityDerive` sí sirve: exige un JWT válido y setea `app.user_id`, que es
 * exactamente el GUC del que depende la política de RLS de 0017 para dejarle ver SU
 * invitación y ninguna otra.
 *
 * ═══ CU-868ktkq8r: EL TOKEN NO PUEDE SER LA ÚNICA LLAVE ═══
 *
 * QA reportó "al aceptar la invitación sigue tirando a login normal y no hay una opción
 * de unirse a una empresa; el usuario invitado no debería crear una empresa". El enlace
 * del correo apunta a una ruta con sesión obligatoria, así que un invitado NUEVO pasa
 * primero por la hosted UI de WorkOS —crear cuenta, verificar correo, a veces en otra
 * pestaña—, y cualquier tropiezo en ese viaje (cookie PKCE perdida, enlace reabierto
 * desde el correo, sesión iniciada antes por la landing) lo deja dentro del producto
 * SIN el `?token=`. Y sin token no había absolutamente ninguna forma de llegar a la
 * empresa que lo invitó: la única pantalla que le quedaba enfrente era la de crear una
 * empresa propia. Un invitado convertido en dueño de una empresa vacía.
 *
 * `GET /invitations/pending` es la salida: la invitación se descubre por el CORREO de la
 * sesión, no por el enlace. No es una llave nueva ni un permiso nuevo —es exactamente la
 * visibilidad "por destinatario" que la política de RLS de 0017 ya concede a propósito, y
 * por la misma razón: quien acepta todavía no tiene empresa que scopear.
 *
 * Y por eso `/accept` admite `invitationId` además de `token`. La pregunta obvia es si
 * eso debilita el token, y la respuesta es no: el token prueba "recibí el correo", pero
 * el chequeo que de verdad autoriza —y que ya existía— es `wrong_recipient`, o sea que
 * el correo de la invitación coincida con el de la cuenta que acepta. Un `invitationId`
 * sin ese empate no acepta nada, y la fila ni siquiera es visible bajo RLS. Lo que el
 * token sigue aportando es el caso en que la invitación se mandó a un correo distinto
 * del de la cuenta: ahí el id no aparece en `pending` y el token da el rechazo explícito.
 */
export const invitationAcceptance = new Elysia({ prefix: '/invitations' })
  .use(identityDerive)

  /**
   * Las invitaciones vivas dirigidas al correo de esta sesión. Es lo que convierte
   * "no hay opción de unirse a una empresa" en una opción concreta con nombre propio.
   *
   * Se filtra por `expires_at` y no por `status`: nada recorre la tabla marcando
   * vencidas, así que una caducada sigue figurando como `pending` (misma razón que
   * documenta `rejectAcceptance`). Ofrecerla sería prometer una puerta que el propio
   * `/accept` va a cerrar.
   *
   * `companies` no tiene RLS —no es tabla de datos de negocio, es el catálogo de
   * empresas—, así que el join resuelve el nombre sin `app.company_id`. Es el mismo
   * join que ya hace `/me/memberships` bajo este guard.
   */
  .get('/pending', async ({ userId, db }) => {
    const [quien] = await db.select({ email: users.email }).from(users).where(eq(users.id, userId));
    if (!quien) return { invitations: [] };

    const invitations = await db
      .select({
        id: companyInvitations.id,
        companyId: companyInvitations.companyId,
        companyName: companies.name,
        role: companyInvitations.role,
        expiresAt: companyInvitations.expiresAt,
      })
      .from(companyInvitations)
      .innerJoin(companies, eq(companies.id, companyInvitations.companyId))
      .where(
        and(
          eq(companyInvitations.status, 'pending'),
          rawSql`lower(${companyInvitations.email}) = ${quien.email.toLowerCase()}`,
          rawSql`${companyInvitations.expiresAt} > now()`,
        ),
      );

    return { invitations };
  })

  .post(
    '/accept',
    async ({ userId, body, set, db, scopeToCompany }) => {
      // Una de las dos, nunca ninguna. Se valida acá y no con un `t.Union` en el
      // esquema porque el error de una unión de TypeBox no dice cuál de las dos formas
      // falló, y este cuerpo lo arma nuestro propio BFF: el mensaje es para el
      // desarrollador que lo rompa, y tiene que nombrar el problema.
      if (!body.token && !body.invitationId) {
        set.status = 400;
        return { error: 'Falta el token de la invitación.', reason: 'not_found' as const };
      }

      const [invitation] = await db
        .select({
          id: companyInvitations.id,
          companyId: companyInvitations.companyId,
          email: companyInvitations.email,
          role: companyInvitations.role,
          status: companyInvitations.status,
          expiresAt: companyInvitations.expiresAt,
        })
        .from(companyInvitations)
        .where(
          body.token
            ? eq(companyInvitations.tokenHash, hashInvitationToken(body.token))
            : eq(companyInvitations.id, body.invitationId!),
        );

      const [quienAcepta] = await db
        .select({ email: users.email })
        .from(users)
        .where(eq(users.id, userId));

      const rechazo = rejectAcceptance(invitation, quienAcepta?.email ?? '', new Date());
      if (rechazo) {
        // 404 y no 403 para `not_found`/`not_pending`: distinguirlos le diría a quien
        // prueba tokens cuáles existen.
        set.status = rechazo === 'wrong_recipient' ? 403 : 404;
        /*
         * `reason` además del texto — CU-868ktkq8r. El texto sigue viajando porque es lo
         * que ve quien depura y lo que la UI muestra si no reconoce el motivo, pero es
         * español quemado en el backend: mostrarlo tal cual dejaba esta pantalla —una de
         * las tres puertas de entrada al producto, y la única que un invitado
         * angloparlante ve antes que ninguna otra— hablando en un idioma que el resto de
         * la app respeta. El código lo traduce el diccionario del cliente.
         *
         * `not_found` y `not_pending` comparten mensaje a propósito (distinguirlos le
         * diría a quien prueba tokens cuáles existen), pero se devuelven separados: el
         * status ya los distingue igual y el cliente los mapea al mismo texto.
         */
        return { error: INVITATION_REJECTION_MESSAGE[rechazo], reason: rechazo };
      }

      // A partir de aquí se escribe en tablas scopeadas por empresa, así que hace falta
      // el segundo GUC — el mismo mecanismo que usa `/register` para la empresa que
      // acaba de crear (ver guards/identity.derive.ts).
      await scopeToCompany(invitation!.companyId);

      /*
       * `onConflictDoUpdate` y no un INSERT pelado — CU-868ktkq8r.
       *
       * La migración 0017 permite EXPLÍCITAMENTE volver a invitar a alguien cuya
       * membresía se revocó ("alguien se va del equipo y vuelve": el índice de
       * invitación única es parcial sobre `pending` justo para eso). Pero la fila de
       * `company_users` no se borra al quitar a alguien —se marca `revoked`, porque es
       * la trazabilidad de quién tuvo acceso a datos financieros—, así que ese reingreso
       * chocaba contra `company_users_company_user_uq` y salía como 500. El camino que
       * la base declara soportado terminaba en un error crudo.
       */
      await db
        .insert(companyUsers)
        .values({
          companyId: invitation!.companyId,
          userId,
          role: invitation!.role,
          status: 'active',
        })
        .onConflictDoUpdate({
          target: [companyUsers.companyId, companyUsers.userId],
          set: { role: invitation!.role, status: 'active', updatedAt: new Date() },
        });

      // El estado se cierra DESPUÉS de crear la membresía: si algo fallara en medio, una
      // invitación pendiente sin membresía se puede reintentar; una consumida sin
      // membresía dejaría a la persona fuera y sin forma de volver a entrar.
      await db
        .update(companyInvitations)
        .set({
          status: 'accepted',
          acceptedAt: new Date(),
          acceptedByUserId: userId,
          updatedAt: new Date(),
        })
        .where(eq(companyInvitations.id, invitation!.id));

      return { companyId: invitation!.companyId, role: invitation!.role };
    },
    {
      body: t.Object({
        token: t.Optional(t.String({ minLength: 20 })),
        invitationId: t.Optional(t.String({ format: 'uuid' })),
      }),
    },
  );
