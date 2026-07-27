import { registerWorker, QUEUES } from '@/queue';
import { withCompanyScope } from '@/lib/db-scope';
import { deliverEmail, type EmailSendPayload } from '@/lib/email';

/** CU-868kfvad9 — the only place that actually calls Resend (SES migration seam). */
export function startEmailSendWorker(): Promise<string> {
  return registerWorker<EmailSendPayload>(QUEUES.emailSend, async (payload) => {
    await withCompanyScope(payload.companyId, (db) => deliverEmail(db, payload));
  });
}
