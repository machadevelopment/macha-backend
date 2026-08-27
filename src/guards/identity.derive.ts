import { Elysia } from 'elysia';
import { verifyBearerOr401 } from '@/guards/bearer';
import { db as rootDb } from '@/db/client';
import { reserveScopedConnection } from '@/lib/db-scope';
import { registrarCierre, cerrarPendiente } from '@/guards/liberar-conexion';
import { resolveOrProvisionUser } from '@/lib/user-provisioning';

/**
 * Lighter guard than tenant.derive.ts (CU-868kfva6c): verifies the bearer JWT and
 * resolves the Macha user row, WITHOUT scoping to a company. This is intentionally
 * the guard used BEFORE a company_id exists — it's what lets the org-switcher list
 * every membership so the user (or the frontend, on a single-membership account) can
 * pick one. Routes needing tenant-scoped data still go through tenantDerive.
 *
 * CU-868kjc4wa — POR QUÉ AHORA RESERVA UNA CONEXIÓN. Este guard servía sus queries con
 * el pool global y sin ningún GUC, lo que funcionaba solo porque `APP_DATABASE_URL`
 * cae al rol dueño cuando no está seteada. Con `macha_app`:
 *
 *   - `/me/memberships` leía `company_users` → 0 filas → el org-switcher vacío;
 *   - `/register` insertaba en `company_users` → `new row violates row-level security
 *     policy`, dejando la empresa recién creada sin usuario ni suscripción.
 *
 * La solución es la misma que en `tenant.derive`: reservar la conexión del request y
 * setear `app.user_id` (la política de `company_users` de la migración 0012 lo
 * contempla). `users` no tiene RLS, así que resolver la identidad sigue usando el pool.
 *
 * `scopeToCompany` existe para `/register`, el único caso que CREA la empresa a la que
 * luego necesita scopearse: `subscriptions` y `alert_rules` sí filtran por
 * `app.company_id`, y ese id no existe hasta media request.
 */
export const identityDerive = new Elysia({ name: 'identity.derive' })
  .derive(async ({ headers, request, set }) => {
    // CU-868kmvaf7: un token vencido devolvía 500 con el texto de `jose`. Ver bearer.ts.
    const token = await verifyBearerOr401(headers['authorization'], set);

    // CU-868kjkfdf: ESTE es el único punto donde una identidad de WorkOS obtiene su fila
    // en `users`. Va aquí y no en `tenant.derive` ni en `admin.guard` a propósito: los
    // dos exigen algo que un usuario recién creado no puede tener todavía (una membresía
    // en `company_users`, una fila en `staff`), así que darlo de alta ahí no
    // desbloquearía nada y solo repartiría la responsabilidad en tres sitios. Este guard
    // es el que sirve `/register` y `/me/memberships`, que son literalmente las dos
    // primeras llamadas de un usuario nuevo. Ver lib/user-provisioning.ts.
    const user = await resolveOrProvisionUser(rootDb, token.sub);

    // A partir de aquí cualquier salida por error DEBE liberar la conexión — de ahí el
    // try/catch, igual que en tenant.derive: `onError` solo cubre lo que Elysia ya
    // considera un request en curso.
    const scoped = await reserveScopedConnection(
      undefined,
      `${request.method} ${new URL(request.url).pathname}`,
    );
    try {
      await scoped.scopeTo('app.user_id', user.id);
      registrarCierre(request, scoped);

      return {
        userId: user.id as string,
        workosUserId: token.sub,
        db: scoped.db,
        /** Solo para /register: amplía el scope a la empresa recién creada. */
        scopeToCompany: (companyId: string) => scoped.scopeTo('app.company_id', companyId),
      };
    } catch (err) {
      await scoped.rollback();
      throw err;
    }
  })
  .onAfterHandle(async ({ request }) => {
    await cerrarPendiente(request, true);
  })
  .onError(async ({ request }) => {
    await cerrarPendiente(request, false);
  })
  // `scoped`, no `global` — misma razón que en tenant.derive.ts. Ver src/app.test.ts.
  .as('scoped');
