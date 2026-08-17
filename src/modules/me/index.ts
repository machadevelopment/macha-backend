import { Elysia, t } from 'elysia';
import { and, eq } from 'drizzle-orm';
import { identityDerive } from '@/guards/identity.derive';
import { companyUsers, companies, staff, users } from '@/db/schema';

/**
 * CU-868kfva6c: lista las membresías activas del usuario autenticado, sin requerir
 * un company_id todavía — es literalmente el endpoint que el org-switcher del
 * frontend usa para saber qué mostrar antes de que exista un contexto de empresa.
 * No hay tenant-scoping aquí a propósito: un usuario puede pertenecer a varias
 * empresas y este endpoint las lista TODAS (siempre limitado a las del propio
 * usuario, vía identityDerive -> company_users.user_id).
 *
 * CU-868kjc4wa: usa el `db` que inyecta identityDerive, no el pool global. Ese db lleva
 * `app.user_id` seteado, que es lo único que hace visibles las membresías propias bajo
 * el rol macha_app (política de `company_users`, migración 0012). Con el pool pelado
 * esto devolvía `[]` y el org-switcher se quedaba sin empresas.
 */
export const me = new Elysia({ prefix: '/me' })
  .use(identityDerive)
  .get('/memberships', async ({ userId, db }) => {
    const memberships = await db
      .select({
        companyId: companyUsers.companyId,
        companyName: companies.name,
        role: companyUsers.role,
      })
      .from(companyUsers)
      .innerJoin(companies, eq(companies.id, companyUsers.companyId))
      .where(and(eq(companyUsers.userId, userId), eq(companyUsers.status, 'active')));

    const [staffRow] = await db
      .select({ tier: staff.tier })
      .from(staff)
      .where(and(eq(staff.userId, userId), eq(staff.status, 'active')))
      .limit(1);

    return { memberships, staffTier: staffRow?.tier ?? null };
  })
  /**
   * CU-868krvuct: persiste el idioma que el usuario eligió en el selector.
   *
   * Hasta acá el selector escribía una cookie del navegador y nada más, así que el servidor
   * nunca supo en qué idioma estaba leyendo el usuario — y el contenido que genera la IA
   * (reportes, chat) se escribía en `companies.locale`, fijado en el registro y no editable
   * desde ninguna pantalla. De ahí el reporte en inglés con la plataforma en español.
   *
   * Va en `/me` y no en `/companies`: es la preferencia de UNA persona, no de la empresa.
   * Dos socios de la misma PYME pueden leer en idiomas distintos y cada uno debe recibir
   * SU reporte en el suyo. El idioma de la empresa sigue existiendo y sigue siendo el que
   * usa el reporte automático diario, que no lo pide nadie.
   *
   * Sin `assertClientCapability`: no hay capacidad que restringir: cualquiera puede elegir
   * en qué idioma lee. Y sin tenant-scoping, igual que `/memberships` — la preferencia es
   * del usuario y no de una empresa, así que se escribe por `userId` del JWT verificado.
   * Ese `where` es lo único que impide escribir la fila de otro, y por eso el id sale del
   * token y nunca del cuerpo.
   */
  .put(
    '/locale',
    async ({ userId, body, db }) => {
      await db.update(users).set({ locale: body.locale }).where(eq(users.id, userId));
      return { locale: body.locale };
    },
    {
      body: t.Object({ locale: t.Union([t.Literal('es'), t.Literal('en')]) }),
      response: {
        200: t.Object({ locale: t.Union([t.Literal('es'), t.Literal('en')]) }),
      },
    },
  );
