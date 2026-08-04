import { eq } from 'drizzle-orm';
import type { DB } from '@/db/client';
import { users } from '@/db/schema';
import { fetchWorkosUser, type WorkosUserFetcher } from './workos-users';

export type ResolvedUser = typeof users.$inferSelect;

/**
 * CU-868kjkfdf: el único camino por el que una identidad de WorkOS obtiene su fila en
 * `users`. Antes no existía ninguno — ni creación JIT, ni webhook, ni paso de seed — y
 * eso cerraba un círculo: los guards exigen la fila para dejar pasar, y lo único que
 * podría crearla (`POST /register`) está detrás de un guard. Todo usuario nuevo de
 * AuthKit recibía `403 No Macha account for this identity` y el alta autoservicio era
 * inalcanzable.
 *
 * LA VÍA ELEGIDA (criterio 1: elegir una y dejarla escrita) es **creación JIT en el
 * guard de identidad**, frente a las otras dos que planteaba el ticket:
 *   - Webhook `user.created` de WorkOS: más auditable, pero suma un endpoint público que
 *     firmar y verificar y exige configurar el dashboard de WorkOS. Además deja una
 *     ventana de carrera real: alguien puede completar el registro en AuthKit y llamar a
 *     `/register` antes de que el webhook llegue, que es justo el caso que hay que cubrir.
 *   - Alta manual desde `/admin`: sirve para clientes onboardeados a mano, pero deja el
 *     registro autoservicio muerto, y M8 lo da por vivo.
 *
 * EL "CONTRA" DEL JIT, ACOTADO. El ticket advierte que "cualquier JWT válido de tu
 * tenant de WorkOS crea una fila". Es cierto y es aceptable: una fila en `users` no
 * concede NADA por sí sola. Todo acceso a datos de negocio pasa por `company_users`
 * (rol + estado) y todo acceso al backoffice por `staff`; esta función no escribe en
 * ninguna de las dos. Lo que se crea es el espejo local de una identidad que WorkOS ya
 * autenticó, no una autorización.
 *
 * Se llama SOLO desde `identity.derive` (ver la nota allí sobre por qué no desde
 * `tenant.derive` ni `admin.guard`).
 */
export async function resolveOrProvisionUser(
  db: DB,
  workosUserId: string,
  fetchProfile: WorkosUserFetcher = fetchWorkosUser,
): Promise<ResolvedUser> {
  const [existing] = await db
    .select()
    .from(users)
    .where(eq(users.workosUserId, workosUserId))
    .limit(1);
  if (existing) return existing;

  // Solo una identidad NUEVA llega hasta aquí, así que la llamada a WorkOS ocurre una
  // vez por usuario en toda su vida, no por request.
  const profile = await fetchProfile(workosUserId);

  // `onConflictDoNothing` en vez de un "if not exists" en la app: dos requests
  // simultáneos del mismo usuario nuevo (el frontend dispara varias llamadas al montar)
  // llegarían los dos aquí con la fila todavía sin existir. El índice único es el
  // árbitro; el re-select de abajo recoge la fila gane quien gane.
  //
  // SIN `target`, Y ESO IMPORTA. `users` tiene DOS índices únicos: `users_workos_user_uq`
  // y `users_email_lower_uq` (expresión `lower(email)`, migración 0004). Un `ON CONFLICT
  // (workos_user_id)` solo silencia el primero — el segundo sigue lanzando
  // `duplicate key value violates unique constraint`. Y en la carrera que esto existe
  // para cubrir, la fila perdedora viola LOS DOS a la vez: misma identidad, mismo correo.
  // Cuál de los dos índices reporta Postgres depende del orden en que inserta las
  // entradas, así que el fallo era intermitente: el test de concurrencia daba 500 en ~2
  // de cada 3 corridas, en local y en CI, sobre el mismo commit.
  //
  // Sin `target` se silencia cualquier índice único, que es justo el comportamiento que
  // ya describía el bloque de abajo: si el INSERT no entró por el índice de correo
  // —otra identidad de WorkOS con el mismo email—, el re-select no encuentra nada y el
  // caso sale por el mensaje explícito, no por un error crudo de Postgres.
  await db
    .insert(users)
    .values({
      workosUserId,
      email: profile.email,
      name: profile.name,
      // `locale` se queda en el default 'es' de la columna: WorkOS no expone preferencia
      // de idioma. `POST /register` lo corrige con el locale que el usuario elige para su
      // empresa, que es el primer momento en que se sabe de verdad (criterio 3).
    })
    .onConflictDoNothing();

  const [provisioned] = await db
    .select()
    .from(users)
    .where(eq(users.workosUserId, workosUserId))
    .limit(1);

  if (!provisioned) {
    // Único camino realista hasta acá: el INSERT no entró por el OTRO índice único, el
    // de `lower(email)` — otra identidad de WorkOS con el mismo correo. Merece un
    // mensaje propio; con el genérico se diagnostica como "el alta no funciona".
    throw new Error(
      `No se pudo dar de alta la identidad ${workosUserId}: ya existe un usuario con el ` +
        `correo ${profile.email} asociado a otra identidad de WorkOS.`,
    );
  }
  return provisioned;
}
