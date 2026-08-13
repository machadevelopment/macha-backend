import { describe, expect, test } from 'bun:test';

process.env.DATABASE_URL ??= 'postgres://smoke:smoke@localhost:5432/smoke';

const { COMPANY_NAME_TAKEN_MESSAGE } = await import('@/modules/billing/register');

describe('conflicto de nombre en el alta', () => {
  test('el mensaje le dice qué hacer: otro nombre o entrar a la que ya tiene', () => {
    expect(COMPANY_NAME_TAKEN_MESSAGE.toLowerCase()).toContain('ya existe');
    expect(COMPANY_NAME_TAKEN_MESSAGE.toLowerCase()).toMatch(/otro|entra/);
  });

  test('no es el genérico de 500 ni pide reintentar a ciegas', () => {
    expect(COMPANY_NAME_TAKEN_MESSAGE.toLowerCase()).not.toContain('500');
    expect(COMPANY_NAME_TAKEN_MESSAGE.toLowerCase()).not.toContain('intenta de nuevo');
  });
});
