import { Elysia, t } from 'elysia';
import { randomUUID } from 'node:crypto';
import { asc, eq, sql } from 'drizzle-orm';
import { identityDerive } from '@/guards/identity.derive';
import { enforceTokenBucketForUser } from '@/lib/rate-limit';
import { companies, companyUsers, plans, subscriptions, users } from '@/db/schema';
import { provisionTenantPartitions } from '@/lib/tenant-provisioning';
import { seedDefaultAlertRules } from '@/lib/alert-rules-seed';
import { grantInitialCredits } from '@/lib/credits';
// `BASE_PLAN_AMOUNT_USD_CENTS` deja de usarse acá (ticket B3): el precio sale del plan
// elegido del catálogo, no de una constante. La constante sigue exportada en
// `provider.ts` porque documenta el precio original de CU-868kfvae6.
import { startSubscriptionCheckout, appBaseUrl } from '@/lib/billing/provider';
import { isBillingConfigured } from '@/lib/billing/recurrente-client';
import { BillingNotConfiguredError } from '@/lib/billing/billing-errors';
import { onboardingUrl } from '@/lib/app-urls';
import { env } from '@/lib/env';
import { normalizeIndustry } from '@/lib/industry-template';

/** Mensaje de conflicto de nombre — único a nivel DB (`companies_name_lower_uq`, migración 0004). */
export const COMPANY_NAME_TAKEN_MESSAGE =
  'Ya existe una empresa con ese nombre. Elige otro o entra a la que ya tienes.';

/**
 * CU-868kfvae1/868kfvaem: registro autoservicio — alta automática de empresa+owner
 * sin intervención del admin (criterio 2 de ambos tickets). Usa identityDerive (F2),
 * no tenantDerive: el usuario ya inició sesión por WorkOS pero todavía no tiene
 * ninguna empresa — es literalmente lo que este endpoint crea.
 *
 * CU-868kjc4wa — DOS COSAS CAMBIARON AQUÍ.
 *
 * 1. **Scoping.** Se escribía con el pool global sin ningún GUC. Bajo el rol macha_app
 *    el INSERT en `company_users` lanza `new row violates row-level security policy`
 *    (la política de 0002/0012 es FOR ALL, así que su USING también sirve de WITH CHECK
 *    para el INSERT). Ahora se usa el `db` de identityDerive, que ya lleva
 *    `app.user_id`; y en cuanto existe la empresa se llama a `scopeToCompany` para que
 *    `subscriptions` y `alert_rules` —que filtran por `app.company_id`— también pasen.
 *
 * 2. **Atomicidad.** No la había: cada paso era autónomo, así que un fallo a mitad
 *    dejaba una empresa sin usuario ni suscripción, y cada reintento del usuario creaba
 *    otra empresa fantasma. Ahora todo corre dentro de la transacción del request
 *    (identityDerive la abre y la cierra en los hooks), así que un throw revierte el
 *    alta completa.
 *
 * El orden importa y no es el que era:
 *   - el checkout con Recurrente ocurre ANTES de insertar la suscripción, para que la
 *     fila nazca con `provider_checkout_id` y desaparezca el UPDATE posterior;
 *   - las particiones se crean PRIMERO, antes del INSERT en `companies`.
 *
 * Ese último punto estaba invertido y colgaba la petición para siempre. Las particiones
 * se creaban al final para no dejar huérfanas si algo fallaba antes — razonable sobre el
 * papel, imposible en la práctica: el DDL corre sobre otra conexión (rol dueño) y
 * `CREATE TABLE ... PARTITION OF transactions` hereda la FK compuesta a `companies`,
 * cuya validación pide un ShareRowExclusiveLock sobre `companies`. Ese lock choca con el
 * RowExclusiveLock que dejó el INSERT de ESTA transacción, que no cierra hasta
 * `onAfterHandle` — o sea, hasta después de este handler. El DDL espera al request y el
 * request espera al DDL. Postgres no lo mata: su detector solo ve ciclos entre locks, y
 * el request no espera un lock sino al cliente (`idle in transaction`).
 *
 * Verificado en producción sobre el gemelo de este código (`POST /admin/companies`, la
 * otra vía por la que nace una empresa): petición colgada indefinidamente y
 * `pg_blocking_pids` confirmando el ciclo.
 *
 * Coste asumido del orden nuevo: si algo falla después, quedan particiones vacías de una
 * empresa que no existe. Es basura inocua —tablas vacías— y `CREATE TABLE IF NOT EXISTS`
 * hace idempotente el reintento; colgar el alta de empresas no tiene arreglo desde fuera.
 *
 * Queda un caso extremo asumido: si el commit falla DESPUÉS del checkout, queda un
 * checkout abierto en Recurrente sin empresa local. El webhook lo ignoraría (no
 * encontraría la suscripción) y el cobro no llegaría a activarse.
 */
export const register = new Elysia({ prefix: '/register' })
  .use(identityDerive)
  /**
   * Catálogo de planes PARA EL ALTA (ticket B4, ronda de QA 2026-08-11).
   *
   * Existe separado de `GET /plans` por una razón estructural, no por comodidad: aquel va
   * sobre `tenantDerive`, que exige una empresa resuelta desde la membresía. Quien está en
   * el wizard de registro TODAVÍA NO TIENE EMPRESA — es literalmente lo que está por
   * crear— así que `/plans` le responde 403 y jamás podría alimentar el selector.
   *
   * Este cuelga de `identityDerive`, el mismo guard que el POST de al lado: exige sesión
   * verificada de WorkOS y nada más. Es la única forma de que el selector de plan pueda
   * existir en el alta.
   *
   * NO expone nada sensible: son los planes públicos que cualquiera vería en una página de
   * precios. Solo los ACTIVOS, porque un plan retirado no se le ofrece a nadie nuevo — y
   * ese filtro importa acá más que en ningún lado: es la pantalla donde se elige por
   * primera vez.
   *
   * Va sin rate limit propio a diferencia del POST. Ese lo lleva porque cada alta corre
   * `CREATE TABLE ... PARTITION OF` tres veces contra el Postgres compartido; esto es un
   * `SELECT` sobre una tabla de tres filas sin `company_id`, que no tiene nada que
   * amplificar.
   */
  .get('/plans', async ({ db }) =>
    db
      .select({
        code: plans.code,
        name: plans.name,
        amountUsdCents: plans.amountUsdCents,
        monthlyCredits: plans.monthlyCredits,
        sortOrder: plans.sortOrder,
      })
      .from(plans)
      .where(eq(plans.active, true))
      .orderBy(asc(plans.sortOrder), asc(plans.code)),
  )
  .post(
    '/',
    async ({ userId, body, set, db, scopeToCompany }) => {
      // CU-868kjc950 criterio 1: por USUARIO, porque aquí todavía no hay empresa. Cada
      // llamada corre `CREATE TABLE ... PARTITION OF` tres veces contra el Postgres
      // compartido: sin techo, esto es DDL ilimitado sobre la base de todos los clientes.
      const limited = await enforceTokenBucketForUser('register', userId, set, 'POST /register');
      if (limited) return limited;

      /*
       * EL PLAN ANTES QUE LA EMPRESA.
       *
       * Antes se resolvía DESPUÉS de particiones + INSERT de `companies` + membresía.
       * `identityDerive` hace commit en cualquier `return` (incluido un 422), así que un
       * catálogo vacío —migración 0021 sin `scripts/seed.ts`— dejaba empresas huérfanas
       * sin suscripción (medido: NINGEN TECH S.A, 2026-08-12). Validar primero evita el
       * DDL caro y el alta a medias.
       *
       * `planCode` sigue opcional: sin él se toma el primer plan ACTIVO por `sort_order`.
       */
      const [planElegido] = body.planCode
        ? await db.select().from(plans).where(eq(plans.code, body.planCode))
        : await db
            .select()
            .from(plans)
            .where(eq(plans.active, true))
            .orderBy(asc(plans.sortOrder), asc(plans.code))
            .limit(1);

      if (!planElegido || !planElegido.active) {
        // 422 y no 500: el cliente mandó un plan que no existe o que ya se retiró, y eso lo
        // puede corregir eligiendo otro. Aún no hay empresa que revertir.
        set.status = 422;
        return { error: `El plan '${body.planCode ?? '(ninguno)'}' no está disponible.` };
      }

      // `companies_name_lower_uq` (migración 0004): el nombre es único sin importar
      // mayúsculas. Reintentar el alta con el mismo nombre (caso típico: la empresa YA
      // quedó creada en un intento anterior y la persona vuelve a /register) reventaba
      // el INSERT con 500 texto plano → el BFF solo decía "El servicio respondió 500."
      // Medido 2026-08-13 con "NINGEN TECH S.A". Se valida ANTES del DDL de particiones
      // para no dejar basura si el nombre choca.
      const nombre = body.name.trim();
      if (!nombre) {
        set.status = 422;
        return { error: 'El nombre de la empresa no puede estar vacío.' };
      }
      const [nombreTomado] = await db
        .select({ id: companies.id })
        .from(companies)
        .where(sql`lower(${companies.name}) = lower(${nombre})`)
        .limit(1);
      if (nombreTomado) {
        set.status = 409;
        return { error: COMPANY_NAME_TAKEN_MESSAGE };
      }

      // Antes del INSERT: ver la nota de arriba sobre el abrazo mortal.
      const companyId = randomUUID();
      await provisionTenantPartitions(companyId);

      const [company] = await db
        .insert(companies)
        .values({
          id: companyId,
          // Sin org de WorkOS propia todavía para una empresa auto-registrada (eso
          // vive en el flujo de invite/multi-tenant de WorkOS, fuera de alcance aquí)
          // — placeholder estable y único por empresa.
          workosOrgId: `self_serve_${randomUUID()}`,
          name: nombre,
          // Normalizada al escribir (lib/industry-template.ts): este es el campo de texto
          // libre que el cliente llena en el wizard de registro, y la llave con la que se
          // busca su plantilla de mapeo. De aquí salió el "TECH" que no encontraba nada.
          industry: normalizeIndustry(body.industry),
          baseCurrency: body.baseCurrency,
          locale: body.locale,
        })
        .returning();

      // Desde aquí las escrituras por empresa pasan la política de RLS. `companies` no
      // tiene RLS, por eso el INSERT de arriba funciona antes de este SET LOCAL.
      await scopeToCompany(company!.id);

      await db.insert(companyUsers).values({
        companyId: company!.id,
        userId,
        role: 'owner',
        status: 'active',
      });

      // CU-868kjkfdf criterio 3: el alta JIT de `users` deja `locale` en el default 'es'
      // porque WorkOS no expone preferencia de idioma. Este es el primer momento en que el
      // idioma se SABE —el usuario acaba de elegirlo para su empresa— así que se sincroniza
      // aquí. De esto dependen los emails de reporte y alerta, que se mandan por
      // `users.locale`, no por el de la empresa.
      await db.update(users).set({ locale: body.locale }).where(eq(users.id, userId));

      await seedDefaultAlertRules(db, company!.id);

      // CU-868kjc7g5 criterio 3 + B3: el abono inicial ahora sale de los créditos del PLAN,
      // con el ajuste global de `platform_settings` como respaldo para los planes que no
      // declaran los suyos.
      await grantInitialCredits(db, company!.id, planElegido.monthlyCredits);

      // CU-868kmxu41 — EL CHECKOUT SE DECIDE, NO SE ASUME.
      //
      // Historia, porque el orden de estas condiciones ya estuvo mal una vez. La primera
      // versión solo miraba la bandera cuando el proveedor NO estaba configurado, así que
      // en cuanto se cargaron las llaves de Recurrente la bandera dejó de servir para
      // nada — justo cuando hacía falta: hay proveedor contratado, pero todavía no se
      // quiere cobrar a los pilotos que están dando feedback.
      //
      // `BILLING_CHECKOUT_OPTIONAL` significa "el registro NO exige checkout", y manda
      // sobre todo lo demás. Las cuatro combinaciones quedan así:
      //
      //   bandera ON,  proveedor configurado  -> sin checkout (modo piloto)
      //   bandera ON,  sin proveedor          -> sin checkout
      //   bandera OFF, proveedor configurado  -> checkout normal, cobro real
      //   bandera OFF, sin proveedor          -> 503 limpio, no un 500 con internals
      //
      // La empresa se crea igual y su suscripción queda en `pending_checkout`, que NO
      // bloquea el acceso: `tenant.derive` solo rechaza `cancelled` (ver su comentario).
      // El piloto entra completo y con los créditos iniciales de CU-868kjc7g5.
      //
      // OJO AL ESTADO PELIGROSO: bandera encendida CON proveedor configurado significa
      // que hay con qué cobrar y no se está cobrando. Es legítimo durante un piloto y es
      // un agujero de ingresos si se olvida encendida, así que el arranque lo grita
      // (ver src/index.ts). Nunca se enciende sola: es opt-in explícito del operador.
      const cobraEsteEntorno = !env.billingCheckoutOptional;

      if (cobraEsteEntorno && !isBillingConfigured()) {
        throw new BillingNotConfiguredError();
      }

      // Un plan GRATUITO no pasa por checkout aunque el entorno cobre: no hay nada que
      // cobrar, y mandar a Recurrente por USD 0 sería un checkout que no puede completarse.
      const cobraEstePlan = cobraEsteEntorno && planElegido.amountUsdCents > 0;

      const checkout = cobraEstePlan
        ? await startSubscriptionCheckout({
            amountUsdCents: planElegido.amountUsdCents,
            companyId: company!.id,
            planName: planElegido.name,
            /*
             * CU-868krmrcj (fase C): vuelve al paso de configuración de archivos, no a `/`.
             *
             * Este destino es el del cliente que SÍ paga, y es la mitad del flujo que el
             * frontend no controla: `register-wizard.tsx` decide a dónde ir cuando NO hay
             * cobro, pero cuando lo hay manda a Recurrente y el regreso lo dicta esta línea.
             * Cambiar solo el frontend habría dejado a los clientes de pago como los únicos
             * que se saltan el onboarding — exactamente al revés de lo deseable.
             *
             * `/` además ni siquiera era el panel: es la pantalla de ENTRADA. El cliente
             * terminaba de pagar y aterrizaba en la puerta, no adentro. Por eso la URL pasa
             * a `lib/app-urls.ts` en vez de quedarse como plantilla suelta acá: ese módulo
             * existe justamente porque un template string suelto ya mandó a un 404 a todos
             * los correos de "reporte listo".
             */
            successUrl: onboardingUrl({ fromCheckout: true }),
            cancelUrl: `${appBaseUrl}/register?cancelled=1`,
          })
        : null;

      await db.insert(subscriptions).values({
        companyId: company!.id,
        planCode: planElegido.code,
        amountUsdCents: planElegido.amountUsdCents,
        status: 'pending_checkout',
        providerCheckoutId: checkout?.providerCheckoutId,
      });

      // `checkoutUrl: null` le dice al frontend "entrá a la app" en vez de redirigir a un
      // checkout que no existe. No se devuelve una cadena vacía: un `null` explícito es
      // imposible de confundir con una URL rota.
      return { companyId: company!.id, checkoutUrl: checkout?.checkoutUrl ?? null };
    },
    {
      body: t.Object({
        name: t.String(),
        industry: t.String(),
        baseCurrency: t.Union([t.Literal('GTQ'), t.Literal('USD')]),
        locale: t.Union([t.Literal('es'), t.Literal('en')]),
        // Opcional hasta que B4 ponga el selector en el alta; sin él se toma el plan de
        // entrada del catálogo. Ver el comentario en el handler.
        planCode: t.Optional(t.String()),
      }),
    },
  );
