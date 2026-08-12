import { Elysia, t } from 'elysia';
import { desc, eq, inArray } from 'drizzle-orm';
import { adminGuard } from '@/guards/admin.guard';
import { assertStaffCapability } from '@/guards/require-capability';
import { companies, plans, subscriptions } from '@/db/schema';
import { getAiUsageTotalsByCompany } from '@/lib/ai-usage';
import { getCreditBalances } from '@/lib/credits';

/**
 * VISTA CONSOLIDADA DE EMPRESAS PARA EL BACKOFFICE (ticket B5).
 *
 * ═══ POR QUÉ EXISTE ═══
 *
 * Los cuatro datos que este endpoint junta ya se podían obtener, pero cada uno desde una
 * pantalla distinta: el plan desde `/admin/companies/:id`, el saldo desde
 * `/admin/companies/:id/credits`, y el costo y los tokens desde `/admin/ai-cost`. Para
 * responder "¿cómo va esta empresa?" el operador tenía que saltar entre tres pantallas y
 * cruzar las cifras de memoria.
 *
 * NO SE AGREGA NINGUNA MÉTRICA NUEVA. Es consolidación: las mismas cuentas que ya
 * existían, servidas juntas. El costo y los tokens salen de `lib/ai-usage.ts` (los
 * mismos agregados que usa `/admin/ai-cost`) y el saldo de `lib/credits.ts` (el mismo
 * `sum(delta)` que usa el detalle de créditos). Si alguna de esas cuentas cambia, cambia
 * en un solo sitio y las dos pantallas se mueven juntas.
 *
 * ═══ POR QUÉ UN ENDPOINT Y NO TRES LLAMADAS DESDE EL FRONTEND ═══
 *
 * `/admin/companies/:id/credits` es POR EMPRESA. Pintar una página de 50 empresas
 * cruzando saldo y costo desde el navegador son 50 peticiones de saldo más la del
 * listado más la de costos — y cada una de esas 50, del lado del backend, reserva su
 * propia conexión con el escape cross-tenant puesto (`admin.guard`). Aquí son CUATRO
 * consultas para toda la página, sin importar cuántas empresas traiga: el listado, los
 * saldos, los totales de IA y las suscripciones. El costo no crece con las filas.
 *
 * ═══ EL DRILL-DOWN NO SE VA ═══
 *
 * Esto da el TOTAL de IA por empresa. La descomposición por tipo de acción
 * (excel/chat/insight/report_generation/excel_correction) sigue viviendo en
 * `GET /admin/ai-cost`, que este ticket no toca: la vista consolidada dice "esta empresa
 * lleva USD X", y para saber en qué se fue se entra al drill-down.
 *
 * ═══ SOLO ADMINISTRACIÓN ═══
 *
 * El costo real en USD y los tokens son cifras de plataforma y el cliente NUNCA las ve
 * (CU-868kfvag7 criterio 3); el cliente ve su saldo en créditos y nada más. Por eso se
 * exigen las DOS capacidades: `view_companies` por el listado y `view_ai_usage_cost` por
 * las columnas de costo. Hoy ambas son `staff` + `super_admin`, así que el efecto es el
 * mismo — pero la respuesta lleva costo dentro, y el gate tiene que decirlo aunque no
 * cambie nada todavía. El día que la matriz separe una de otra, este endpoint no se
 * convierte en la puerta de atrás de `/admin/ai-cost`.
 *
 * Es un endpoint de LECTURA: no muta nada, así que no escribe `admin_audit_log` (ese
 * requisito de CLAUDE.md aplica a las mutaciones de `/admin/*`).
 */

const CEROS = { totalCostUsd: '0', totalInputTokens: '0', totalOutputTokens: '0', callCount: '0' };

export const adminCompanyOverview = new Elysia({ prefix: '/admin/companies' })
  .use(adminGuard)
  /**
   * `/overview` convive con el `/:id` de `modules/admin/companies.ts` sin ambigüedad: el
   * router de Elysia resuelve el segmento estático antes que el dinámico, incluso
   * estando declarados en plugins distintos (verificado montando los dos plugins y
   * llamando a las dos rutas). Por eso puede ir en su propio módulo en vez de engordar
   * `companies.ts`.
   */
  .get(
    '/overview',
    async ({ tier, query, set, db }) => {
      assertStaffCapability(tier, 'view_companies', set);
      assertStaffCapability(tier, 'view_ai_usage_cost', set);

      // Mismo contrato de paginación que `GET /admin/companies` (limit+1 para saber si
      // hay más sin un COUNT aparte): el panel reusa su "cargar más" tal cual.
      const limit = Math.min(Number(query.limit ?? 50) || 50, 200);
      const offset = Math.max(Number(query.offset ?? 0) || 0, 0);

      const pagina = await db
        .select({
          id: companies.id,
          name: companies.name,
          industry: companies.industry,
          baseCurrency: companies.baseCurrency,
          status: companies.status,
          createdAt: companies.createdAt,
        })
        .from(companies)
        .orderBy(desc(companies.createdAt))
        .limit(limit + 1)
        .offset(offset);

      const filas = pagina.slice(0, limit);
      const hasMore = pagina.length > limit;
      if (filas.length === 0) return { companies: [], hasMore: false };

      const ids = filas.map((c) => c.id);

      // Las tres agregaciones van EN SERIE a propósito. `db` aquí es la conexión
      // reservada del request (una sola, con el escape cross-tenant puesto): postgres.js
      // encola las consultas de una misma conexión, así que un `Promise.all` no las
      // paralelizaría — solo escondería que no lo hace.
      const saldos = await getCreditBalances(db, ids);
      const consumo = await getAiUsageTotalsByCompany(db, ids);

      /**
       * PLAN. Se lee de `subscriptions` y se resuelve el NOMBRE contra el catálogo
       * `plans` (tabla nueva del ticket B3, migración 0021, ya en `dev`).
       *
       * El `leftJoin` —y no un `innerJoin`— es deliberado: `plans` nació con un backfill
       * de los `plan_code` existentes, pero una suscripción cuyo plan se retiró del
       * catálogo tiene que seguir apareciendo con su código. Una empresa sin plan visible
       * es peor que una empresa con un plan sin nombre bonito.
       *
       * Se ordena por `createdAt` descendente y se queda la PRIMERA de cada empresa: el
       * modelo no impide dos filas (una cancelada y su reemplazo), y sin orden explícito
       * "el plan de la empresa" dependería del orden físico de las filas.
       */
      const suscripciones = await db
        .select({
          companyId: subscriptions.companyId,
          planCode: subscriptions.planCode,
          planName: plans.name,
          subscriptionStatus: subscriptions.status,
        })
        .from(subscriptions)
        .leftJoin(plans, eq(plans.code, subscriptions.planCode))
        .where(inArray(subscriptions.companyId, ids))
        .orderBy(desc(subscriptions.createdAt));

      const planPorEmpresa = new Map<string, (typeof suscripciones)[number]>();
      for (const s of suscripciones)
        if (!planPorEmpresa.has(s.companyId)) planPorEmpresa.set(s.companyId, s);

      return {
        companies: filas.map((c) => {
          const uso = consumo.get(c.id) ?? CEROS;
          const suscripcion = planPorEmpresa.get(c.id);
          return {
            ...c,
            // `null` explícito, no cadena vacía: "esta empresa no tiene suscripción" es
            // un estado real (las creadas a mano por el admin antes de M8) y la pantalla
            // tiene que poder distinguirlo de un plan llamado "".
            planCode: suscripcion?.planCode ?? null,
            planName: suscripcion?.planName ?? null,
            subscriptionStatus: suscripcion?.subscriptionStatus ?? null,
            // Sin movimientos en el ledger el saldo es 0, no "desconocido".
            creditBalance: saldos.get(c.id) ?? 0,
            // Se conservan los nombres de campo de `/admin/ai-cost` para que la pantalla
            // formatee las dos tablas con el mismo código.
            totalCostUsd: uso.totalCostUsd,
            totalInputTokens: uso.totalInputTokens,
            totalOutputTokens: uso.totalOutputTokens,
            callCount: uso.callCount,
          };
        }),
        hasMore,
      };
    },
    { query: t.Object({ limit: t.Optional(t.String()), offset: t.Optional(t.String()) }) },
  );
