import { createHash, randomBytes } from 'node:crypto';

/**
 * CU-868kh8pwv — token de invitación.
 *
 * El token viaja en el enlace del correo y es, en la práctica, una credencial: quien lo
 * tenga obtiene acceso a los datos financieros de una empresa. De ahí las dos reglas de
 * este archivo, ambas comprobables sin base de datos.
 *
 * 1. SE GUARDA EL HASH, NUNCA EL CLARO. La regla no negociable de CLAUDE.md ("no
 *    passwords/secrets in the DB") no habla solo de contraseñas. Un dump, un backup o un
 *    staff con acceso a la base no deben poder usar las invitaciones pendientes. El
 *    claro existe únicamente en el correo del invitado.
 *
 * 2. ENTROPÍA DE VERDAD, NO UN UUID. Un uuid v4 se ve aleatorio y sirve como
 *    identificador, pero un identificador no es un secreto: aquí se usan 32 bytes de
 *    `randomBytes` (256 bits) en base64url. No `Math.random()`, que no es
 *    criptográficamente seguro y es el error clásico en este mismo sitio.
 */

/** Días que una invitación sigue siendo aceptable. */
export const INVITATION_TTL_DAYS = 7;

export function generateInvitationToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashInvitationToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Vencimiento a partir de un instante dado.
 *
 * Recibe el "ahora" en vez de leer el reloj: así la caducidad se puede fijar en un test
 * sin congelar el tiempo global, y el llamador es dueño explícito del instante que usa.
 */
export function invitationExpiry(now: Date): Date {
  return new Date(now.getTime() + INVITATION_TTL_DAYS * 24 * 60 * 60 * 1000);
}

export type InvitationRejection = 'not_found' | 'not_pending' | 'expired' | 'wrong_recipient';

export interface InvitationForAcceptance {
  status: 'pending' | 'accepted' | 'revoked' | 'expired';
  expiresAt: Date;
  email: string;
}

/**
 * ¿Se puede aceptar esta invitación? Devuelve el motivo del rechazo, o `null` si procede.
 *
 * Función pura y separada del handler porque es donde se concentra todo lo que puede
 * salir mal en una aceptación, y cada rama es un agujero de seguridad si se cae:
 *
 * · `wrong_recipient` — el chequeo que impide que un token filtrado (reenviado, sacado
 *   de un log de correo) sirva para meter a CUALQUIER cuenta en la empresa. Sin él, el
 *   token sería un pase al portador. Se compara en minúsculas porque el correo no
 *   distingue mayúsculas para este propósito.
 * · `expired` — la caducidad se comprueba contra el reloj, no contra el campo `status`:
 *   nada recorre la tabla marcando vencidas, así que una invitación caducada sigue
 *   figurando como `pending` hasta que alguien la toca.
 * · `not_pending` — cubre revocada y ya aceptada. Un token usado no se reutiliza.
 */
export function rejectAcceptance(
  invitation: InvitationForAcceptance | undefined,
  acceptingEmail: string,
  now: Date,
): InvitationRejection | null {
  if (!invitation) return 'not_found';
  if (invitation.status !== 'pending') return 'not_pending';
  if (invitation.expiresAt.getTime() <= now.getTime()) return 'expired';
  if (invitation.email.toLowerCase() !== acceptingEmail.toLowerCase()) return 'wrong_recipient';
  return null;
}

/**
 * Mensajes por motivo. Deliberadamente parcos: no se le dice a quien presenta un token
 * ajeno "esta invitación es para otra persona" con el correo del destinatario dentro,
 * porque eso convierte un token filtrado en una forma de descubrir quién fue invitado.
 */
export const INVITATION_REJECTION_MESSAGE: Record<InvitationRejection, string> = {
  not_found: 'La invitación no existe o ya no es válida.',
  not_pending: 'La invitación no existe o ya no es válida.',
  expired: 'La invitación venció. Pide una nueva al owner de la empresa.',
  wrong_recipient: 'Esta invitación no corresponde a tu cuenta.',
};
