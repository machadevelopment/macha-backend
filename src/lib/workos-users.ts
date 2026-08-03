import { env } from './env';

/**
 * Perfil de una identidad de WorkOS, leído de su Management API.
 *
 * POR QUÉ EXISTE ESTE ARCHIVO (CU-868kjkfdf). El ticket proponía crear la fila de
 * `users` "con el email/nombre del JWT". **El access token de WorkOS no los trae**:
 * sus claims son `sub`, `sid`, `org_id`, `role`, `roles`, `permissions` y
 * `entitlements` (verificado en el tipo `AccessToken` de `@workos-inc/authkit-nextjs`,
 * que es el emisor real de la sesión). Y `users.email` es NOT NULL con UNIQUE sobre
 * `lower(email)`, así que no hay forma de dar de alta la fila sin un email de verdad.
 *
 * Las tres salidas posibles y por qué esta:
 *   - Pedírselo al cliente (que el frontend mande el email en /register). DESCARTADO:
 *     viola la regla no negociable de que la identidad se resuelve server-side desde el
 *     JWT verificado y nunca desde el cliente. Un email de request es un email elegido.
 *   - Inventar un placeholder (`${sub}@invalid`). DESCARTADO: ensucia un índice único
 *     y deja datos falsos en un producto financiero, para siempre y en silencio.
 *   - Preguntarle a WorkOS por el `sub` que ya venía firmado. ESTA. El `sub` sale de un
 *     token cuya firma ya se verificó contra el JWKS, y el email lo contesta el emisor
 *     de la identidad, no la parte interesada.
 *
 * Sin dependencia nueva: `fetch` nativo de Bun contra la Management API. Añadir el SDK
 * `@workos-inc/node` por una sola llamada GET no se justifica (regla de CLAUDE.md sobre
 * verificar cada dependencia contra Bun antes de sumarla).
 */
export interface WorkosUserProfile {
  email: string;
  name: string | null;
}

/** Inyectable para poder probar el alta sin red — mismo patrón que `TokenBucketRedis`. */
export type WorkosUserFetcher = (workosUserId: string) => Promise<WorkosUserProfile>;

/**
 * Falla con un mensaje accionable en vez de un 500 opaco: sin `WORKOS_API_KEY` el alta
 * de una identidad nueva es imposible, y eso hay que decirlo donde se lee (ver README,
 * sección de arranque local). Los usuarios YA dados de alta no pasan por aquí, así que
 * un entorno sin la clave sigue sirviendo a todo el mundo que ya existe.
 */
export const fetchWorkosUser: WorkosUserFetcher = async (workosUserId) => {
  if (!env.workosApiKey) {
    throw new Error(
      'WORKOS_API_KEY no está configurada: no se puede dar de alta una identidad nueva. ' +
        'Ver README, "Arranque local".',
    );
  }

  const res = await fetch(`https://api.workos.com/user_management/users/${workosUserId}`, {
    headers: { Authorization: `Bearer ${env.workosApiKey}` },
  });

  if (!res.ok) {
    throw new Error(`WorkOS respondió ${res.status} al pedir el usuario ${workosUserId}`);
  }

  const body = (await res.json()) as {
    email?: string;
    first_name?: string | null;
    last_name?: string | null;
  };

  if (!body.email) {
    throw new Error(`WorkOS devolvió el usuario ${workosUserId} sin email`);
  }

  const name = [body.first_name, body.last_name].filter(Boolean).join(' ').trim();
  return { email: body.email, name: name.length > 0 ? name : null };
};
