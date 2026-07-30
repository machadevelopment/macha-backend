import { Elysia } from 'elysia';
import { and, eq } from 'drizzle-orm';
import { subscriptions, payments, creditTransactions } from '@/db/schema';
import { verifyAndParseWebhook } from '@/lib/billing/provider';
import { withCompanyScope } from '@/lib/db-scope';

/**
 * CU-868kfvaed: público (sin JWT — verificado por firma svix, no por sesión de
 * usuario), fuera de tenantDerive/adminGuard a propósito.
 *
 * Idempotencia (criterio 1, no negociable): `payments.provider_event_id` es UNIQUE a
 * nivel de columna; `.onConflictDoNothing()` es la comprobación real (sin condición
 * de carrera), no un "if exists" a nivel de app.
 *
 * CU-868kjc4wa — SCOPING SIN USUARIO. Esto usaba la conexión root sin GUC, con el
 * argumento de que el company_id viene del metadata del checkout y no de un tenant
 * resuelto. Bajo el rol macha_app eso ya no se sostiene: `payments`,
 * `credit_transactions` y `subscriptions` tienen RLS por empresa, así que el INSERT
 * fallaba con `new row violates row-level security policy` y el UPDATE de la
 * suscripción no encontraba ninguna fila — los pagos nunca se conciliaban.
 *
 * La empresa SÍ se conoce: sale del metadata de un evento cuya firma HMAC ya se
 * verificó, que es una fuente tan server-side como el JWT. Así que todo el trabajo
 * corre dentro de `withCompanyScope(companyId)` — el mismo primitivo que usan los
 * workers de pg-boss, que también operan sin usuario. Como abre una transacción, el
 * pago y su abono de créditos ahora son atómicos: antes podían quedar desparejados.
 */
export const billingWebhooks = new Elysia({ prefix: '/webhooks/recurrente' }).post(
  '/',
  async ({ request, set }) => {
    const rawBody = await request.text();
    const svixId = request.headers.get('svix-id');
    const svixTimestamp = request.headers.get('svix-timestamp');
    const svixSignature = request.headers.get('svix-signature');

    if (!svixId || !svixTimestamp || !svixSignature) {
      set.status = 400;
      return { error: 'Missing svix headers' };
    }

    let event;
    try {
      event = verifyAndParseWebhook({
        svixId,
        svixTimestamp,
        svixSignatureHeader: svixSignature,
        rawBody,
      });
    } catch {
      set.status = 400;
      return { error: 'Invalid signature' };
    }

    const companyId = event.metadata?.companyId;
    if (!companyId) {
      // Not one of ours (or malformed metadata) — ack with 200 so the provider
      // doesn't keep retrying a webhook we were never going to act on.
      return { received: true };
    }

    await withCompanyScope(companyId, async (db) => {
      if (event.kind === 'payment_succeeded') {
        const [inserted] = await db
          .insert(payments)
          .values({
            companyId,
            kind: event.metadata?.kind === 'credit_topup' ? 'credit_topup' : 'subscription_charge',
            providerEventId: event.eventId,
            providerPaymentId: event.providerPaymentId,
            status: 'succeeded',
            amountUsdCents: event.amountUsdCents ?? 0,
            creditsGranted: event.metadata?.credits ? Number(event.metadata.credits) : undefined,
          })
          .onConflictDoNothing({ target: payments.providerEventId })
          .returning();

        if (!inserted) return; // already processed this event — no-op, per criterio 1

        if (event.metadata?.kind === 'credit_topup' && event.metadata.credits) {
          await db.insert(creditTransactions).values({
            companyId,
            delta: Number(event.metadata.credits),
            reason: 'top_up',
            refId: inserted.id,
          });
        } else {
          // `company_id` explícito además del GUC: RLS es el backstop, no el filtro
          // (regla no negociable). Sin él, este UPDATE se apoyaba solo en que
          // provider_checkout_id fuera único entre TODAS las empresas.
          await db
            .update(subscriptions)
            .set({ status: 'active' })
            .where(
              and(
                eq(subscriptions.companyId, companyId),
                eq(subscriptions.providerCheckoutId, event.providerPaymentId ?? ''),
              ),
            );
        }
      } else if (event.kind === 'payment_failed') {
        const [inserted] = await db
          .insert(payments)
          .values({
            companyId,
            kind: event.metadata?.kind === 'credit_topup' ? 'credit_topup' : 'subscription_charge',
            providerEventId: event.eventId,
            providerPaymentId: event.providerPaymentId,
            status: 'failed',
            amountUsdCents: event.amountUsdCents ?? 0,
            failureReason: 'Recurrente reported payment failure',
          })
          .onConflictDoNothing({ target: payments.providerEventId })
          .returning();

        if (inserted && event.metadata?.kind !== 'credit_topup') {
          await db
            .update(subscriptions)
            .set({ status: 'past_due' })
            .where(eq(subscriptions.companyId, companyId));
          // "Backoff de 24h + notificación al equipo" (criterio 3): el reintento de
          // cobro en sí lo maneja Recurrente (su propio dunning) — lo que falta acá es
          // un canal real de notificación interna (Slack/PagerDuty), que no existe en
          // este repo todavía. Placeholder explícito: log estructurado.
          console.error('[billing] payment failed, subscription past_due', {
            companyId,
            eventId: event.eventId,
          });
        }
      } else if (event.kind === 'subscription_status' && event.subscriptionStatus) {
        await db
          .update(subscriptions)
          .set({
            status: event.subscriptionStatus,
            providerSubscriptionId: event.providerSubscriptionId,
          })
          .where(eq(subscriptions.companyId, companyId));
      }
    });

    return { received: true };
  },
);
