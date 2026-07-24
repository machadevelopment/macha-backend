import { Resend } from 'resend';
import { env } from './env';

// Emails carry a LINK to the authenticated in-app view, never financial attachments.
export const resend = env.resendApiKey ? new Resend(env.resendApiKey) : null;
