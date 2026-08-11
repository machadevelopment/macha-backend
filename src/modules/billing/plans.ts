import { Elysia, t } from 'elysia';
import { and, asc, desc, eq } from 'drizzle-orm';
import { tenantDerive } from '@/guards/tenant.derive';
import { assertClientCapability } from '@/guards/require-capability';
import { plans, subscriptions } from '@/db/schema';

/**
 * Planes del lado CLIENTE (ticket B3, ronda de QA 2026-08-11).
 *
 * La pantalla de Créditos solo permitía comprar créditos sueltos. Pasa a ser gestión de
 * plan: ver el plan actual, comparar el catálogo y hacer upgrade — sin perder la recarga
 * individual, que sigue viviendo en `credits-topup.ts` y no se toca.
 *
 * QUIÉN VE Y QUIÉN CAMBIA. El listado va con `view_dashboard_reports` (los tres roles):
 * saber en qué plan está su empresa y qué hay disponible no es información sensible, y
 * esconderla al `member` solo lo obliga a preguntar. Cambiar de plan va con `billing`, que
 * ya era `['owner']` en la matriz aprobada por Jose — no se inventa una capacidad nueva.
 *
 * ═══ EL UPGRADE NO COBRA, Y ESO ES UNA DECISIÓN, NO UN PENDIENTE ═══
 *
 * Para el demo el cambio de plan actualiza la suscripción sin pasar por Recurrente. Es la
 * recomendación que el propio ticket traía, y hay una razón concreta más allá del demo:
 * los precios de la tabla son PROVISIONALES ("los montos exactos se definen después"), y
 * cobrar de verdad contra un precio provisional es un cargo real que después hay que
 * reembolsar de verdad.
 *
 * La infraestructura de cobro ya existe (`startSubscriptionCheckout`, los webhooks, la
 * tabla `payments` con su idempotencia por evento), así que conectarla cuando haya precios
 * cerrados es enchufar el checkout en este handler, no construirlo.
 *
 * ═══ EL UPGRADE NO ACREDITA CRÉDITOS, Y ESO TAMPOCO ES UN OLVIDO ═══
 *
 * El plan declara `monthlyCredits` y esos créditos alimentan el ABONO INICIAL de una
 * empresa nueva (`grantInitialCredits`). Al cambiar de plan NO se abona la diferencia,
 * porque hacerlo obliga a responder una pregunta que el producto tiene abierta: qué pasa
 * con el saldo no usado —¿se pierde, se acumula, se topa?— y si el upgrade prorratea. Es
 * literalmente la decisión pendiente de PRD §12 punto 4, la misma por la que
 * `grantInitialCredits` documenta que la asignación mensual recurrente NO entró en v1.
 *
 * Inventar una respuesta acá la dejaría escrita en el código como si estuviera decidida.
 * Mientras tanto el super_admin tiene la recarga manual (`admin/credits.ts`), que es
 * mecanismo puro y no compromete ninguna de las respuestas posibles.
 */
export const clientPlans = new Elysia({ prefix: '/plans' })
  .use(tenantDerive)
  .get('/', async ({ companyId, role, set, db }) => {
    assertClientCapability(role, 'view_dashboard_reports', set);

    // Solo los ACTIVOS: un plan retirado del catálogo no se le ofrece a nadie nuevo.
    const catalogo = await db
      .select()
      .from(plans)
      .where(eq(plans.active, true))
      .orderBy(asc(plans.sortOrder), asc(plans.code));

    /*
     * La suscripción vigente. `orderBy desc(createdAt) limit 1` y no un `findFirst`
     * cualquiera: una empresa puede acumular filas —un `pending_checkout` abandonado más
     * la buena— y sin orden explícito Postgres puede devolver cualquiera. La más reciente
     * es la que manda.
     */
    const [actual] = await db
      .select({
        planCode: subscriptions.planCode,
        status: subscriptions.status,
        amountUsdCents: subscriptions.amountUsdCents,
      })
      .from(subscriptions)
      .where(eq(subscriptions.companyId, companyId))
      .orderBy(desc(subscriptions.createdAt))
      .limit(1);

    /*
     * El plan actual se busca en el catálogo COMPLETO, no en `catalogo`: una empresa
     * puede estar en un plan ya retirado (`active = false`) —de hecho toda empresa
     * anterior a este ticket está en `base`, que la migración 0021 dio de alta inactivo—
     * y devolver `null` ahí le mostraría "sin plan" a alguien que sí tiene uno.
     */
    const [planActual] = actual
      ? await db.select().from(plans).where(eq(plans.code, actual.planCode))
      : [];

    return {
      current: actual
        ? {
            ...actual,
            name: planActual?.name ?? actual.planCode,
            monthlyCredits: planActual?.monthlyCredits ?? null,
          }
        : null,
      available: catalogo,
    };
  })
  .post(
    '/change',
    async ({ companyId, role, body, set, db }) => {
      assertClientCapability(role, 'billing', set);

      const [destino] = await db.select().from(plans).where(eq(plans.code, body.planCode));
      if (!destino) {
        set.status = 404;
        return { error: `El plan '${body.planCode}' no existe.` };
      }
      if (!destino.active) {
        // Un plan retirado se conserva para quien ya lo tiene, pero no se puede elegir.
        // 409 y no 404: existe, simplemente no está disponible.
        set.status = 409;
        return { error: `El plan '${body.planCode}' ya no está disponible.` };
      }

      const [actual] = await db
        .select({ id: subscriptions.id, planCode: subscriptions.planCode })
        .from(subscriptions)
        .where(eq(subscriptions.companyId, companyId))
        .orderBy(desc(subscriptions.createdAt))
        .limit(1);

      if (!actual) {
        set.status = 409;
        return { error: 'La empresa no tiene ninguna suscripción sobre la que cambiar de plan.' };
      }
      if (actual.planCode === body.planCode) {
        // No es un error: es el estado que el usuario pidió. Se responde 200 sin escribir,
        // que además hace la operación idempotente ante un doble clic.
        return { planCode: actual.planCode, changed: false };
      }

      // `company_id` explícito además del id de la suscripción: RLS es el backstop, no el
      // filtro (CLAUDE.md). El id solo bastaría, pero dejar la condición de tenant escrita
      // es lo que hace que un error en la resolución del id no se convierta en una
      // escritura cruzada entre empresas.
      await db
        .update(subscriptions)
        .set({
          planCode: destino.code,
          amountUsdCents: destino.amountUsdCents,
          updatedAt: new Date(),
        })
        .where(and(eq(subscriptions.id, actual.id), eq(subscriptions.companyId, companyId)));

      return { planCode: destino.code, changed: true };
    },
    { body: t.Object({ planCode: t.String() }) },
  );
