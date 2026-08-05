import { describe, expect, test, beforeAll, afterAll } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { setupTestDatabase, appConnection, ownerConnection, rejectionCode } from './setup';

/**
 * CU-868kh8pwv — la parte de las invitaciones que NO se puede probar sin Postgres real:
 * la política de RLS de la migración 0017.
 *
 * Es el mismo problema de arranque que 0012 resolvió para `company_users`, y por eso
 * merece su propio test contra base real: quien acepta una invitación TODAVÍA NO es
 * miembro de la empresa, así que su request no tiene `app.company_id`. Si la política
 * solo mirara la empresa, aceptar sería imposible — cero filas visibles — y el bug no
 * aparecería en ningún test unitario, igual que no apareció el de CU-868kjc4wa.
 *
 * La contracara es igual de importante: que la vía "por destinatario" no se convierta en
 * una rendija para ver invitaciones ajenas.
 */
describe('RLS de company_invitations (CU-868kh8pwv)', () => {
  let app: ReturnType<typeof appConnection>;
  let owner: ReturnType<typeof ownerConnection>;

  const empresaA = randomUUID();
  const empresaB = randomUUID();
  const usuarioInvitado = randomUUID();
  const usuarioAjeno = randomUUID();
  const usuarioQueInvita = randomUUID();
  const correoInvitado = `invitado-${randomUUID()}@ejemplo.com`;

  beforeAll(async () => {
    await setupTestDatabase();
    app = appConnection();
    owner = ownerConnection();

    await owner`
      insert into companies (id, workos_org_id, name, industry, base_currency, locale)
      values
        (${empresaA}, ${'org_' + empresaA}, ${'Invitaciones A ' + empresaA}, 'retail', 'GTQ', 'es'),
        (${empresaB}, ${'org_' + empresaB}, ${'Invitaciones B ' + empresaB}, 'retail', 'GTQ', 'es')
    `;
    await owner`
      insert into users (id, workos_user_id, email)
      values
        (${usuarioInvitado}, ${'wos_' + usuarioInvitado}, ${correoInvitado}),
        (${usuarioAjeno}, ${'wos_' + usuarioAjeno}, ${'ajeno-' + randomUUID() + '@ejemplo.com'}),
        (${usuarioQueInvita}, ${'wos_' + usuarioQueInvita}, ${'jefe-' + randomUUID() + '@ejemplo.com'})
    `;
    await owner`
      insert into company_users (company_id, user_id, role, status)
      values (${empresaA}, ${usuarioQueInvita}, 'owner', 'active')
    `;
    await owner`
      insert into company_invitations
        (company_id, email, role, token_hash, invited_by_user_id, expires_at)
      values
        (${empresaA}, ${correoInvitado}, 'member', ${'hash_a_' + randomUUID()},
         ${usuarioQueInvita}, now() + interval '7 days')
    `;
  });

  afterAll(async () => {
    await app?.end();
    await owner?.end();
  });

  test('el invitado ve SU invitación sin tener todavía app.company_id', async () => {
    // El caso que hace falta que funcione para que aceptar sea posible: identidad
    // resuelta, membresía inexistente. Es exactamente el estado de `identityDerive`.
    const filas = await app.begin(async (tx) => {
      await tx`select set_config('app.user_id', ${usuarioInvitado}, true)`;
      return tx`select company_id, email from company_invitations`;
    });
    expect(filas).toHaveLength(1);
    expect(filas[0]!.company_id).toBe(empresaA);
  });

  test('otro usuario autenticado NO ve la invitación ajena', async () => {
    // La vía "por destinatario" no puede ser una rendija: sin esto, cualquier cuenta
    // con sesión leería a quién está invitando cada empresa.
    const filas = await app.begin(async (tx) => {
      await tx`select set_config('app.user_id', ${usuarioAjeno}, true)`;
      return tx`select id from company_invitations`;
    });
    expect(filas).toHaveLength(0);
  });

  test('el owner ve las invitaciones de SU empresa', async () => {
    const filas = await app.begin(async (tx) => {
      await tx`select set_config('app.user_id', ${usuarioQueInvita}, true)`;
      await tx`select set_config('app.company_id', ${empresaA}, true)`;
      return tx`select email from company_invitations`;
    });
    expect(filas.map((f) => f.email)).toEqual([correoInvitado]);
  });

  test('una empresa no ve las invitaciones de otra', async () => {
    const filas = await app.begin(async (tx) => {
      await tx`select set_config('app.company_id', ${empresaB}, true)`;
      return tx`select id from company_invitations`;
    });
    expect(filas).toHaveLength(0);
  });

  test('sin ningún GUC no se ve nada — el modo de fallo es "no ve", no "ve todo"', async () => {
    const filas = await app`select id from company_invitations`;
    expect(filas).toHaveLength(0);
  });

  test('no se puede tener dos invitaciones pendientes para el mismo correo', async () => {
    // El árbitro es el índice parcial, no una comprobación en la app: entre consultar y
    // escribir caben dos peticiones simultáneas.
    const code = await rejectionCode(
      owner`
        insert into company_invitations
          (company_id, email, role, token_hash, invited_by_user_id, expires_at)
        values (${empresaA}, ${correoInvitado.toUpperCase()}, 'admin',
                ${'hash_dup_' + randomUUID()}, ${usuarioQueInvita}, now() + interval '7 days')
      `,
    );
    expect(code).toBe('23505');
  });

  test('sí se puede volver a invitar a alguien cuya invitación se revocó', async () => {
    // El índice es PARCIAL sobre `pending` justamente para esto: alguien se va del
    // equipo y vuelve, y una invitación muerta no debe bloquearlo para siempre.
    const correo = `revocado-${randomUUID()}@ejemplo.com`;
    await owner`
      insert into company_invitations
        (company_id, email, role, token_hash, invited_by_user_id, expires_at, status)
      values (${empresaA}, ${correo}, 'member', ${'hash_rev_' + randomUUID()},
              ${usuarioQueInvita}, now() + interval '7 days', 'revoked')
    `;
    const code = await rejectionCode(
      owner`
        insert into company_invitations
          (company_id, email, role, token_hash, invited_by_user_id, expires_at)
        values (${empresaA}, ${correo}, 'member', ${'hash_new_' + randomUUID()},
                ${usuarioQueInvita}, now() + interval '7 days')
      `,
    );
    expect(code).toBeUndefined();
  });

  test('una invitación no puede crear un owner', async () => {
    // Invariante 2: transferir la propiedad es explícito, nunca el efecto colateral de
    // mandar un correo. El CHECK lo impide incluso saltándose la app.
    const code = await rejectionCode(
      owner`
        insert into company_invitations
          (company_id, email, role, token_hash, invited_by_user_id, expires_at)
        values (${empresaA}, ${'jefe-nuevo-' + randomUUID() + '@x.com'}, 'owner',
                ${'hash_own_' + randomUUID()}, ${usuarioQueInvita}, now() + interval '7 days')
      `,
    );
    expect(code).toBe('23514'); // check_violation
  });
});
