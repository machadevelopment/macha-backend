import { Elysia, t } from 'elysia';
import { asc, eq } from 'drizzle-orm';
import { adminGuard } from '@/guards/admin.guard';
import { assertStaffCapability } from '@/guards/require-capability';
import { logAdminAction } from '@/lib/admin-audit';
import { plans } from '@/db/schema';

/**
 * CRUD del catálogo de planes (ticket B3, ronda de QA 2026-08-11).
 *
 * Gateado con `manage_plans_and_templates`, que ya existía en `lib/permissions.ts` y ya
 * era `['super_admin']` — no se inventa una capacidad nueva. Es coherente con el resto de
 * la configuración económica: `edit_action_to_credits_ratio` y
 * `edit_credits_to_tokens_param` también son solo super_admin, porque todas tocan dinero.
 *
 * EL CATÁLOGO SE EDITA SIN DESPLEGAR. Es el criterio explícito del ticket, y el mismo
 * patrón que ya usan las reglas de crédito y `platform_settings`: los precios y los
 * paquetes de créditos son decisiones comerciales que cambian de una semana a otra, y
 * cada cambio no puede costar un deploy.
 *
 * TODA MUTACIÓN ESCRIBE `admin_audit_log`. No es opcional: CLAUDE.md lo exige para
 * cualquier mutación de `/admin/*`, y acá con más razón — cambiar cuántos créditos trae un
 * plan altera lo que reciben todas las empresas que se den de alta después.
 *
 * NO HAY DELETE, y no es un olvido. La baja es lógica (`active = false`). Una empresa
 * puede estar suscrita a un plan que ya no se ofrece, y borrar la fila o rompería la FK de
 * `subscriptions` o dejaría a esa empresa apuntando a la nada. Retirar del catálogo y
 * borrar del historial son cosas distintas.
 */
export const adminPlans = new Elysia({ prefix: '/admin/plans' })
  .use(adminGuard)
  .get('/', async ({ tier, set, db }) => {
    assertStaffCapability(tier, 'manage_plans_and_templates', set);
    // Incluye los inactivos: el panel de administración tiene que poder ver y reactivar
    // un plan retirado. El listado del CLIENTE (modules/billing/plans.ts) sí filtra.
    return db.select().from(plans).orderBy(asc(plans.sortOrder), asc(plans.code));
  })
  .post(
    '/',
    async ({ staffId, tier, body, set, db }) => {
      assertStaffCapability(tier, 'manage_plans_and_templates', set);

      const [existente] = await db
        .select({ code: plans.code })
        .from(plans)
        .where(eq(plans.code, body.code));
      if (existente) {
        // 409 y no 500: que el código ya exista es una condición de negocio que el
        // operador puede resolver (elegir otro código o editar el que hay), no un fallo.
        set.status = 409;
        return { error: `Ya existe un plan con el código '${body.code}'.` };
      }

      const [row] = await db.insert(plans).values(body).returning();
      await logAdminAction(db, {
        actorStaffId: staffId,
        action: 'plan.create',
        targetTable: 'plans',
        targetId: body.code,
        metadata: { ...body },
      });
      return row;
    },
    {
      body: t.Object({
        // El código viaja a `subscriptions.plan_code` y a la URL, así que se restringe a
        // minúsculas, dígitos y guion bajo. Un código con espacios o acentos funcionaría
        // hoy y se rompería el día que alguien lo ponga en una ruta.
        code: t.String({ pattern: '^[a-z0-9_]+$', minLength: 2, maxLength: 40 }),
        name: t.String({ minLength: 1 }),
        amountUsdCents: t.Integer({ minimum: 0 }),
        monthlyCredits: t.Integer({ minimum: 0 }),
        sortOrder: t.Optional(t.Integer()),
        active: t.Optional(t.Boolean()),
      }),
    },
  )
  .patch(
    '/:code',
    async ({ staffId, tier, params, body, set, db }) => {
      assertStaffCapability(tier, 'manage_plans_and_templates', set);

      const [antes] = await db.select().from(plans).where(eq(plans.code, params.code));
      if (!antes) {
        set.status = 404;
        return { error: `El plan '${params.code}' no existe.` };
      }

      // `code` NO es editable, y por eso no está en el body. Es la PK y la referencia
      // ya escrita en las suscripciones vivas: renombrarlo obligaría a actualizarlas en
      // cascada. Si un código está mal, se crea el nuevo y se desactiva el viejo.
      const [row] = await db
        .update(plans)
        .set({ ...body, updatedAt: new Date() })
        .where(eq(plans.code, params.code))
        .returning();

      await logAdminAction(db, {
        actorStaffId: staffId,
        action: 'plan.update',
        targetTable: 'plans',
        targetId: params.code,
        // Se guarda el ANTES y el DESPUÉS. Un audit log que solo dice "se cambió el
        // precio" no sirve para reconstruir qué se cobraba cuándo, que es exactamente la
        // pregunta que se le va a hacer a esta bitácora.
        metadata: {
          before: {
            amountUsdCents: antes.amountUsdCents,
            monthlyCredits: antes.monthlyCredits,
            active: antes.active,
          },
          after: { ...body },
        },
      });
      return row;
    },
    {
      params: t.Object({ code: t.String() }),
      body: t.Object({
        name: t.Optional(t.String({ minLength: 1 })),
        amountUsdCents: t.Optional(t.Integer({ minimum: 0 })),
        monthlyCredits: t.Optional(t.Integer({ minimum: 0 })),
        sortOrder: t.Optional(t.Integer()),
        active: t.Optional(t.Boolean()),
      }),
    },
  );
