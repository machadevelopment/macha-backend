import { Elysia } from 'elysia';
import * as Sentry from '@sentry/bun';
import { env } from '@/lib/env';
import { adminCompanies } from '@/modules/admin/companies';
import { adminStagingRows } from '@/modules/admin/staging-rows';
import { adminIndustryTemplates } from '@/modules/admin/industry-templates';
import { adminConfig } from '@/modules/admin/config';
import { adminCreditRules } from '@/modules/admin/credit-rules';
import { adminAlertRules } from '@/modules/admin/alert-rules';
import { adminMonitoring } from '@/modules/admin/monitoring';
import { alerts } from '@/modules/alerts';
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
  return (
    new Elysia()
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
      .use(adminCompanies)
      .use(adminStagingRows)
      .use(adminIndustryTemplates)
      .use(adminConfig)
      .use(adminCreditRules)
      .use(adminAlertRules)
      .use(adminMonitoring)
      .use(register)
      .use(creditsTopup)
      .use(billingWebhooks)
      .use(me)
      .get('/', () => ({ service: 'macha-backend', env: env.nodeEnv }))
      // Devuelve `undefined` a propósito: Sentry registra y Elysia sigue con su
      // manejo de error por defecto (el status que el guard ya puso en `set`).
      .onError(({ error }) => {
        Sentry.captureException(error);
      })
  );
}

export type App = ReturnType<typeof createApp>;
