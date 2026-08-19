import { Elysia } from 'elysia';
import * as Sentry from '@sentry/bun';
import { env } from '@/lib/env';
import { AiProviderError, aiFailureMessage, aiFailureStatus } from '@/lib/ai-errors';
import { adminCompanies } from '@/modules/admin/companies';
import { adminCompanyOverview } from '@/modules/admin/company-overview';
import { adminStagingRows } from '@/modules/admin/staging-rows';
import { adminIndustryTemplates } from '@/modules/admin/industry-templates';
import { adminConfig } from '@/modules/admin/config';
import { adminFxRates } from '@/modules/admin/fx-rates';
import { adminCreditRules } from '@/modules/admin/credit-rules';
import { adminCredits } from '@/modules/admin/credits';
import { adminAlertRules } from '@/modules/admin/alert-rules';
import { adminMonitoring } from '@/modules/admin/monitoring';
import { adminPlans } from '@/modules/admin/plans';
import { clientPlans } from '@/modules/billing/plans';
import { alerts } from '@/modules/alerts';
import { clientAlertRules } from '@/modules/alert-rules';
import { register } from '@/modules/billing/register';
import { creditsTopup } from '@/modules/billing/credits-topup';
import { billingWebhooks } from '@/modules/billing/webhooks';
import { chats_ } from '@/modules/chats';
import { health } from '@/modules/health';
import { ingestion } from '@/modules/ingestion';
import { industryTemplateDownload } from '@/modules/industry-templates';
import { insights, creditsBalance } from '@/modules/insights';
import {
  metrics,
  arAp,
  arApCounterparties,
  metricsPeriod,
  metricsProducts,
  metricsCategories,
} from '@/modules/metrics';
import { inventory } from '@/modules/inventory';
import { me } from '@/modules/me';
import {
  BillingNotConfiguredError,
  BillingProviderError,
  BILLING_PROVIDER_MESSAGE,
  BILLING_PROVIDER_STATUS,
  BILLING_NOT_CONFIGURED_STATUS,
  BILLING_NOT_CONFIGURED_MESSAGE,
} from '@/lib/billing/billing-errors';
import { members, invitationAcceptance } from '@/modules/members';
import { transactionsList } from '@/modules/transactions';
import { reports_ } from '@/modules/reports';

/**
 * Composición de la API. Vive aparte de `src/index.ts` —que además hace `.listen()` y
 * arranca los workers de pg-boss— para que un test pueda montar EXACTAMENTE esta app y
 * llamarla con `app.handle()` sin abrir un puerto ni una cola.
 *
 * No es una separación cosmética: la única forma de detectar un fallo de composición
 * (un guard que se filtra a un módulo vecino) es ejercitar la app entera, y si el test
 * tuviera que recrear la lista de `.use()` a mano dejaría de representar lo que se
 * despliega en cuanto alguien agregue un módulo aquí y no allá. Ver `src/app.test.ts`.
 */
/**
 * ⚠️ LOS MÓDULOS VAN AGRUPADOS EN DOS PLUGINS, Y NO ES ORGANIZACIÓN COSMÉTICA.
 *
 * `createApp` era una sola cadena de ~30 `.use()`. Cada eslabón acumula tipos en el
 * genérico de Elysia, y al agregar los dos módulos de planes (ticket B3) `tsc` cortó con
 * `TS2589: Type instantiation is excessively deep and possibly infinite` sobre
 * `export type App = ReturnType<typeof createApp>`. No es un error del código: es el
 * compilador llegando a su tope de profundidad.
 *
 * Partirlo en dos plugins baja la profundidad de la cadena a la mitad y deja margen para
 * los módulos que vengan. La app compuesta es EXACTAMENTE la misma —`.use()` de un plugin
 * que a su vez hizo `.use()` es lo mismo que hacerlos en línea— y `app.test.ts` sigue
 * ejercitando la app entera, que era el punto de que este archivo exista.
 *
 * Si vuelve a aparecer TS2589 al sumar módulos, la salida es la misma: otro grupo, no
 * ensanchar el tipo de `App`.
 */
const clientApi = new Elysia()
  .use(health)
  .use(ingestion)
  .use(industryTemplateDownload)
  .use(metrics)
  .use(arAp)
  .use(arApCounterparties)
  .use(metricsPeriod)
  .use(metricsProducts)
  .use(metricsCategories)
  .use(inventory)
  .use(insights)
  .use(creditsBalance)
  .use(chats_)
  .use(reports_)
  .use(alerts)
  .use(clientAlertRules)
  .use(clientPlans);

const adminApi = new Elysia()
  .use(adminCompanies)
  .use(adminCompanyOverview)
  .use(adminStagingRows)
  .use(adminIndustryTemplates)
  .use(adminConfig)
  .use(adminFxRates)
  .use(adminCreditRules)
  .use(adminCredits)
  .use(adminAlertRules)
  .use(adminMonitoring)
  .use(adminPlans);

export function createApp() {
  return (
    new Elysia()
      /*
       * ═══ VA ARRIBA DE LOS `.use(...)`, Y ESO ES LO QUE LO HACE FUNCIONAR ═══
       *
       * Este bloque vivía al FINAL de la cadena y no se ejecutaba para casi nada. Los hooks de
       * Elysia aplican a lo que se monta DESPUÉS de registrarlos, así que un `onError` al final
       * no alcanza a ninguno de los plugins de arriba — o sea, a toda la app.
       *
       * Se comprobó midiendo, no leyendo: un 401 de `bearer.ts` salía como texto plano y sin
       * `content-type`, aunque este handler dijera lo contrario. Mover el bloque acá arriba lo
       * arregló; `{ as: 'global' }` por sí solo NO bastó, y se conserva porque es lo que hace
       * que además cubra los plugins con nombre propio.
       *
       * Los errores de negocio de más abajo (IA, facturación) SÍ funcionaban desde siempre
       * porque sus módulos los lanzan durante el handler, no en un `derive` de un plugin
       * montado antes. Esa asimetría es justo lo que hacía difícil de ver el problema.
       */
      .onError({ as: 'global' }, ({ error, set }) => {
        // CU-868kmvaf7: los errores de CLIENTE no van a Sentry. Un token vencido es el
        // evento más rutinario que existe —los access tokens de WorkOS duran minutos— y
        // antes generaba un evento cada vez. Con tráfico real eso ahoga los errores de
        // verdad, que es peor que no tener monitoreo: da la sensación de estar mirando.
        //
        // Se mira `set.status` y no el tipo de error a propósito: cubre de una vez los
        // 401 de sesión, los 403 de capacidad y los 404, sin tener que enumerar clases.
        // Lo que no clasificó ningún guard sigue subiendo entero.
        const status = typeof set.status === 'number' ? set.status : 500;
        const esErrorDeCliente = status >= 400 && status < 500;
        if (!esErrorDeCliente) Sentry.captureException(error);

        // CU-868kmr192: el fallo del proveedor de IA se traduce ANTES de responder.
        // Sin esto, Elysia serializaba el error del SDK tal cual y el cliente recibía
        // el JSON de Anthropic completo — incluido "Your credit balance is too low to
        // access the Anthropic API", que le decía a una empresa con créditos de sobra
        // que se había quedado sin saldo, y con `request_id` del proveedor de regalo.
        // CU-868kmwn3q: mismo tratamiento y por la misma razón que el de IA — un error de
        // configuración del servidor no es información del usuario, y el texto crudo
        // llevaba dentro el nombre de la variable de entorno.
        if (error instanceof BillingNotConfiguredError) {
          set.status = BILLING_NOT_CONFIGURED_STATUS;
          return { error: BILLING_NOT_CONFIGURED_MESSAGE };
        }

        if (error instanceof BillingProviderError) {
          set.status = BILLING_PROVIDER_STATUS;
          return { error: BILLING_PROVIDER_MESSAGE };
        }

        if (error instanceof AiProviderError) {
          set.status = aiFailureStatus(error.failure);
          return { error: aiFailureMessage(error.failure) };
        }

        /*
         * ═══ TODO ERROR SALE EN JSON, NUNCA EN TEXTO PLANO (2026-08-19) ═══
         *
         * Acá se devolvía `undefined` para dejar que Elysia hiciera su manejo por defecto. Ese
         * default serializa el `error.message` A SECAS, sin `Content-Type: application/json`,
         * y eso rompió el frontend en producción.
         *
         * El recorrido completo: `tenant.derive.ts` respondió `403 Not a member of the
         * requested company` —correctísimo— y el proxy del BFF, que hacía `await res.json()`,
         * explotó con `SyntaxError: Unexpected token 'N', "Not a memb"... is not valid JSON`.
         * El usuario vio un 500 opaco donde el backend había explicado exactamente qué pasaba.
         * El frontend tenía su parte de culpa y ya se arregló (macha-frontend#168), pero la
         * causa de fondo es que este contrato era inconsistente consigo mismo: los errores de
         * negocio de arriba SÍ devuelven `{ error }` y los de guard no.
         *
         * ═══ EL MENSAJE SE FILTRA POR STATUS ═══
         *
         * 4xx: el mensaje del guard es información para el cliente y se manda tal cual — "no
         * eres miembro de esa empresa", "la empresa está suspendida", "falta X-Company-Id" son
         * justo lo que quien integra necesita leer.
         *
         * 5xx: NUNCA el mensaje real. Un error no manejado lleva adentro rutas de archivo,
         * nombres de variables de entorno y, con un error de Postgres, fragmentos de la
         * consulta. Ya pasó dos veces (CU-868kmr192 con el JSON de Anthropic, CU-868kmwn3q con
         * el nombre de una variable de entorno) y el arreglo fue el mismo: traducir antes de
         * responder. Se generaliza acá para que el próximo error no manejado no vuelva a
         * filtrar nada — Sentry ya recibió el detalle unas líneas más arriba.
         */
        const mensaje = error instanceof Error ? error.message : String(error);
        return { error: esErrorDeCliente ? mensaje : 'Unexpected server error' };
      })
      .use(clientApi)
      .use(adminApi)
      .use(register)
      .use(creditsTopup)
      .use(billingWebhooks)
      .use(me)
      .use(transactionsList)
      .use(members)
      .use(invitationAcceptance)
      .get('/', () => ({ service: 'macha-backend', env: env.nodeEnv }))
  );
}

export type App = ReturnType<typeof createApp>;
