import { describe, expect, test } from 'bun:test';
import {
  generateInvitationToken,
  hashInvitationToken,
  invitationExpiry,
  rejectAcceptance,
  INVITATION_TTL_DAYS,
  type InvitationForAcceptance,
} from './invitations';

const AHORA = new Date('2026-08-05T12:00:00Z');

const invitacion = (over: Partial<InvitationForAcceptance> = {}): InvitationForAcceptance => ({
  status: 'pending',
  expiresAt: new Date('2026-08-12T12:00:00Z'),
  email: 'ana@empresa.com',
  ...over,
});

describe('token de invitación (CU-868kh8pwv)', () => {
  test('el hash no permite recuperar el token', () => {
    const token = generateInvitationToken();
    expect(hashInvitationToken(token)).not.toContain(token);
    expect(hashInvitationToken(token)).toHaveLength(64); // sha256 en hex
  });

  test('el mismo token da siempre el mismo hash — así se busca en la base', () => {
    const token = generateInvitationToken();
    expect(hashInvitationToken(token)).toBe(hashInvitationToken(token));
  });

  test('dos invitaciones nunca comparten token', () => {
    const tokens = new Set(Array.from({ length: 200 }, () => generateInvitationToken()));
    expect(tokens.size).toBe(200);
  });

  test('el token tiene entropía de secreto, no de identificador', () => {
    // 32 bytes en base64url son 43 caracteres. Un uuid v4 (36 con guiones) se ve
    // aleatorio y sirve para identificar, pero identificar no es guardar un secreto.
    expect(generateInvitationToken().length).toBeGreaterThanOrEqual(43);
  });

  test('la caducidad sale del instante que le pasan, no del reloj del proceso', () => {
    const vence = invitationExpiry(AHORA);
    expect(vence.getTime() - AHORA.getTime()).toBe(INVITATION_TTL_DAYS * 86_400_000);
  });
});

describe('rejectAcceptance (CU-868kh8pwv)', () => {
  test('una invitación pendiente y vigente para el destinatario correcto pasa', () => {
    expect(rejectAcceptance(invitacion(), 'ana@empresa.com', AHORA)).toBeNull();
  });

  test('un token que no existe no se acepta', () => {
    expect(rejectAcceptance(undefined, 'ana@empresa.com', AHORA)).toBe('not_found');
  });

  test('un token filtrado NO sirve para meter a otra cuenta en la empresa', () => {
    // Sin esta comprobación el token sería un pase al portador: quien lo reenvíe, o lo
    // saque de un log de correo, entraría a los datos financieros de la empresa.
    expect(rejectAcceptance(invitacion(), 'atacante@otro.com', AHORA)).toBe('wrong_recipient');
  });

  test('el correo se compara sin distinguir mayúsculas', () => {
    // "Ana@Empresa.com" no es una segunda persona; rechazarla sería un falso negativo
    // que deja al invitado legítimo fuera.
    expect(rejectAcceptance(invitacion(), 'Ana@Empresa.COM', AHORA)).toBeNull();
  });

  test('una invitación vencida se rechaza aunque siga marcada como pendiente', () => {
    // Nada recorre la tabla marcando vencidas, así que el estado `pending` sobrevive a
    // la caducidad. La verdad es el reloj, no la columna.
    const vencida = invitacion({ expiresAt: new Date('2026-08-01T12:00:00Z') });
    expect(rejectAcceptance(vencida, 'ana@empresa.com', AHORA)).toBe('expired');
  });

  test('el borde exacto del vencimiento se considera vencido', () => {
    const justo = invitacion({ expiresAt: AHORA });
    expect(rejectAcceptance(justo, 'ana@empresa.com', AHORA)).toBe('expired');
  });

  test('un token ya usado no se reutiliza', () => {
    expect(rejectAcceptance(invitacion({ status: 'accepted' }), 'ana@empresa.com', AHORA)).toBe(
      'not_pending',
    );
  });

  test('una invitación revocada deja de servir de inmediato', () => {
    expect(rejectAcceptance(invitacion({ status: 'revoked' }), 'ana@empresa.com', AHORA)).toBe(
      'not_pending',
    );
  });

  test('el destinatario se verifica ANTES de dejar entrar, no después', () => {
    // Orden importa: una invitación revocada Y con destinatario equivocado no debe
    // filtrar por el mensaje que el correo invitado existía.
    const revocadaYAjena = invitacion({ status: 'revoked' });
    expect(rejectAcceptance(revocadaYAjena, 'atacante@otro.com', AHORA)).toBe('not_pending');
  });
});
