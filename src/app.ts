import { Elysia } from 'elysia';
import * as Sentry from '@sentry/bun';
import { env } from '@/lib/env';
import { AiProviderError, aiFailureMessage, aiFailureStatus } from '@/lib/ai-errors';
import { adminCompanies } from '@/modules/admin/companies';
import { adminStagingRows } from '@/modules/admin/staging-rows';
import { adminIndustryTemplates } from '@/modules/admin/industry-templates';
import { adminConfig } from '@/modules/admin/config';
import { adminFxRates } from '@/modules/admin/fx-rates';
import { adminCreditRules } from '@/modules/admin/credit-rules';
import { adminCredits } from '@/modules/admin/credits';
import { adminAlertRules } from '@/modules/admin/alert-rules';
import { adminMonitoring } from '@/modules/admin/monitoring';
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
import { metrics, arAp } from '@/modules/metrics';
import { me } from '@/modules/me';
import {
  BillingNotConfiguredError,
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
export function createApp() {
  return new Elysia()
    .use(health)
    .use(ingestion)
    .use(industryTemplateDownload)
    .use(metrics)
    .use(arAp)
    .use(insights)
    .use(creditsBalance)
    .use(chats_)
    .use(reports_)
    .use(alerts)
    .use(clientAlertRules)
    .use(adminCompanies)
    .use(adminStagingRows)
    .use(adminIndustryTemplates)
    .use(adminConfig)
    .use(adminFxRates)
    .use(adminCreditRules)
    .use(adminCredits)
    .use(adminAlertRules)
    .use(adminMonitoring)
    .use(register)
    .use(creditsTopup)
    .use(billingWebhooks)
    .use(me)
    .use(transactionsList)
    .use(members)
    .use(invitationAcceptance)
    .get('/', () => ({ service: 'macha-backend', env: env.nodeEnv }))
    .onError(({ error, set }) => {
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

      if (error instanceof AiProviderError) {
        set.status = aiFailureStatus(error.failure);
        return { error: aiFailureMessage(error.failure) };
      }

      // Para todo lo demás devuelve `undefined` a propósito: Sentry registra y Elysia
      // sigue con su manejo por defecto (el status que el guard ya puso en `set`).
    });
}

export type App = ReturnType<typeof createApp>;
