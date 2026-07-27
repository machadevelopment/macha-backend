import { Elysia } from 'elysia';
import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { subscriptions, payments, creditTransactions } from '@/db/schema';
import { verifyAndParseWebhook } from '@/lib/billing/provider';

/**
 * CU-868kfvaed: público (sin JWT — verificado por firma svix, no por sesión de
 * usuario), fuera de tenantDerive/adminGuard a propósito. Usa la conexión root (sin
 * RLS/company_id): el company_id viene del metadata del checkout, no de un tenant ya
 * resuelto — mismo patrón que el namespace admin.
 *
 * Idempotencia (criterio 1, no negociable): `payments.provider_event_id` es UNIQUE a
 * nivel de columna; `.onConflictDoNothing()` es la comprobación real (sin condición
 * de carrera), no un "if exists" a nivel de app.
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

      if (!inserted) return { received: true }; // already processed this event — no-op, per criterio 1

      if (event.metadata?.kind === 'credit_topup' && event.metadata.credits) {
        await db.insert(creditTransactions).values({
          companyId,
          delta: Number(event.metadata.credits),
          reason: 'top_up',
          refId: inserted.id,
        });
      } else {
        await db
          .update(subscriptions)
          .set({ status: 'active' })
          .where(eq(subscriptions.providerCheckoutId, event.providerPaymentId ?? ''));
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

    return { received: true };
  },
);
