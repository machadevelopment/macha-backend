import { describe, expect, test, beforeAll, afterAll, mock } from 'bun:test';
import { randomUUID } from 'node:crypto';
import {
  setupTestDatabase,
  appConnection,
  ownerConnection,
  rejectionCode,
  testOwnerUrl,
  testAppUrl,
} from './setup';

// El env debe quedar seteado ANTES de importar cualquier módulo que lea `env`:
// src/lib/env.ts lo evalúa en el import y src/db/client.ts abre el pool ahí mismo.
process.env.DATABASE_URL = testOwnerUrl;
process.env.APP_DATABASE_URL = testAppUrl;
process.env.WORKOS_JWKS_URL = 'https://example.invalid/jwks';

/** El "token" es literalmente el workos_user_id — basta para ejercitar el guard. */
mock.module('@/lib/auth', () => ({
  verifyToken: async (token: string) => ({ sub: token }),
}));

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

// ---------------------------------------------------------------------------
// CU-868ktkq8r — el camino de aceptación, extremo a extremo contra Postgres real
// ---------------------------------------------------------------------------

const { invitationAcceptance } = await import('@/modules/members');
const { Elysia } = await import('elysia');
const { hashInvitationToken } = await import('@/lib/invitations');

const api = new Elysia().use(invitationAcceptance);

function pedir(path: string, workosUserId: string, body?: unknown) {
  return api.handle(
    new Request(`http://localhost${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        authorization: `Bearer ${workosUserId}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
}

/**
 * CU-868ktkq8r — "al aceptar la invitación sigue tirando a login normal y no hay una
 * opción de unirse a una empresa; el usuario invitado no debería crear una empresa".
 *
 * Estos tests van contra Postgres real y con el rol `macha_app` porque lo que se prueba
 * ES pertenencia a empresa: quién puede ver qué invitación y quién termina dentro de qué
 * `company_users`. Con mocks se prueba la forma del handler y se pierde exactamente lo
 * único que importa — que la política de RLS de 0017 deje ver la invitación propia con
 * solo `app.user_id`, y que no deje ver ninguna otra.
 *
 * El caso central es `GET /invitations/pending`: la invitación se encuentra por el CORREO
 * de la sesión y no por el `?token=` del enlace. Sin eso, el invitado que perdió la query
 * en el viaje por la hosted UI de WorkOS —crear cuenta, verificar correo, a veces en otra
 * pestaña— no tenía NINGUNA forma de llegar a la empresa que lo invitó, y la única
 * pantalla que le quedaba enfrente era la de crear una empresa propia.
 */
describe('aceptación de invitaciones sin depender del token (CU-868ktkq8r)', () => {
  let owner: ReturnType<typeof ownerConnection>;

  const empresa = randomUUID();
  const otraEmpresa = randomUUID();
  const jefe = randomUUID();
  const invitado = randomUUID();
  const ajeno = randomUUID();
  const reingresa = randomUUID();

  const correoInvitado = `pend-invitado-${randomUUID()}@ejemplo.com`;
  const correoAjeno = `pend-ajeno-${randomUUID()}@ejemplo.com`;
  const correoReingresa = `pend-vuelve-${randomUUID()}@ejemplo.com`;

  let invitacionDelInvitado: string;
  let invitacionVencida: string;
  let invitacionDeReingreso: string;

  beforeAll(async () => {
    await setupTestDatabase();
    owner = ownerConnection();

    await owner`
      insert into companies (id, workos_org_id, name, industry, base_currency, locale)
      values
        (${empresa}, ${'org_' + empresa}, ${'Ferretería ' + empresa}, 'retail', 'GTQ', 'es'),
        (${otraEmpresa}, ${'org_' + otraEmpresa}, ${'Panadería ' + otraEmpresa}, 'retail', 'GTQ', 'es')
    `;
    await owner`
      insert into users (id, workos_user_id, email)
      values
        (${jefe}, ${'wos_' + jefe}, ${'jefe-' + randomUUID() + '@ejemplo.com'}),
        (${invitado}, ${'wos_' + invitado}, ${correoInvitado}),
        (${ajeno}, ${'wos_' + ajeno}, ${correoAjeno}),
        (${reingresa}, ${'wos_' + reingresa}, ${correoReingresa})
    `;
    await owner`
      insert into company_users (company_id, user_id, role, status)
      values (${empresa}, ${jefe}, 'owner', 'active')
    `;

    // Quien vuelve al equipo: su membresía NO se borró al quitarlo, se marcó `revoked`
    // (es la trazabilidad de quién tuvo acceso a datos financieros).
    await owner`
      insert into company_users (company_id, user_id, role, status)
      values (${empresa}, ${reingresa}, 'member', 'revoked')
    `;

    const filas = await owner`
      insert into company_invitations
        (company_id, email, role, token_hash, invited_by_user_id, expires_at)
      values
        (${empresa}, ${correoInvitado}, 'admin', ${'h_pend_' + randomUUID()},
         ${jefe}, now() + interval '7 days'),
        (${otraEmpresa}, ${correoAjeno}, 'member', ${'h_venc_' + randomUUID()},
         ${jefe}, now() - interval '1 day'),
        (${empresa}, ${correoReingresa}, 'member', ${'h_vuelve_' + randomUUID()},
         ${jefe}, now() + interval '7 days')
      returning id, email
    `;
    invitacionDelInvitado = filas.find((f) => f.email === correoInvitado)!.id;
    invitacionVencida = filas.find((f) => f.email === correoAjeno)!.id;
    invitacionDeReingreso = filas.find((f) => f.email === correoReingresa)!.id;
  });

  afterAll(async () => {
    await owner?.end();
  });

  test('un usuario SIN ninguna empresa ve su invitación por el correo de la sesión', async () => {
    // El caso del bug: sin `?token=` y sin membresía, esto es lo único que puede llevarlo
    // a la empresa que lo invitó en vez de al alta.
    const res = await pedir('/invitations/pending', `wos_${invitado}`);
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      invitations: { id: string; companyName: string; role: string }[];
    };
    expect(body.invitations).toHaveLength(1);
    expect(body.invitations[0]!.id).toBe(invitacionDelInvitado);
    expect(body.invitations[0]!.companyName).toContain('Ferretería');
    // El rol viaja con la invitación: quien invita decide, no quien acepta.
    expect(body.invitations[0]!.role).toBe('admin');
  });

  test('y no ve las de nadie más — la vía "por destinatario" no es una rendija', async () => {
    const res = await pedir('/invitations/pending', `wos_${jefe}`);
    const body = (await res.json()) as { invitations: unknown[] };
    expect(body.invitations).toEqual([]);
  });

  test('una invitación VENCIDA no se ofrece, aunque su status siga en pending', async () => {
    // Nada recorre la tabla marcando vencidas, así que el filtro va contra el reloj.
    // Ofrecerla sería prometer una puerta que `/accept` cierra un clic después.
    const res = await pedir('/invitations/pending', `wos_${ajeno}`);
    const body = (await res.json()) as { invitations: unknown[] };
    expect(body.invitations).toEqual([]);
    expect(invitacionVencida).toBeDefined();
  });

  test('aceptar por invitationId crea la membresía con el rol de la invitación', async () => {
    const res = await pedir('/invitations/accept', `wos_${invitado}`, {
      invitationId: invitacionDelInvitado,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ companyId: empresa, role: 'admin' });

    const [membresia] = await owner`
      select role, status from company_users
      where company_id = ${empresa} and user_id = ${invitado}
    `;
    expect(membresia).toEqual({ role: 'admin', status: 'active' });

    // Y el invitado entra a la empresa QUE LO INVITÓ, no a una nueva: nadie creó nada.
    const [{ count }] = await owner`
      select count(*)::int as count from companies where workos_org_id = ${'org_' + empresa}
    `;
    expect(count).toBe(1);
  });

  test('la invitación queda consumida y no se puede reusar', async () => {
    const [inv] = await owner`
      select status, accepted_by_user_id from company_invitations
      where id = ${invitacionDelInvitado}
    `;
    expect(inv!.status).toBe('accepted');
    expect(inv!.accepted_by_user_id).toBe(invitado);

    const res = await pedir('/invitations/accept', `wos_${invitado}`, {
      invitationId: invitacionDelInvitado,
    });
    expect(res.status).toBe(404);
    expect((await res.json()) as { error: string }).toHaveProperty('error');
  });

  test('un id de invitación AJENA no sirve: ni la ve, ni la acepta', async () => {
    // El id no es un secreto —viaja en la lista de su destinatario—, así que la
    // autorización no puede depender de que sea difícil de adivinar. La sostienen las
    // dos capas de siempre: RLS no muestra la fila, y `rejectAcceptance` compara correos.
    const res = await pedir('/invitations/accept', `wos_${ajeno}`, {
      invitationId: invitacionDeReingreso,
    });
    expect(res.status).toBe(404);

    const filas = await owner`
      select 1 from company_users where company_id = ${empresa} and user_id = ${ajeno}
    `;
    expect(filas).toHaveLength(0);
  });

  test('quien se fue del equipo y vuelve reactiva su membresía en vez de reventar', async () => {
    // La 0017 permite EXPLÍCITAMENTE reinvitar a alguien revocado (su índice de
    // invitación única es parcial sobre `pending`), pero la fila de `company_users`
    // sigue ahí: el INSERT pelado chocaba contra `company_users_company_user_uq` y salía
    // como 500. El camino que la base declara soportado terminaba en un error crudo.
    const res = await pedir('/invitations/accept', `wos_${reingresa}`, {
      invitationId: invitacionDeReingreso,
    });
    expect(res.status).toBe(200);

    const filas = await owner`
      select role, status from company_users
      where company_id = ${empresa} and user_id = ${reingresa}
    `;
    expect(filas).toHaveLength(1);
    expect(filas[0]).toEqual({ role: 'member', status: 'active' });
  });

  test('un cuerpo sin token ni id se rechaza con 400, no con un 500', async () => {
    const res = await pedir('/invitations/accept', `wos_${invitado}`, {});
    expect(res.status).toBe(400);
  });

  test('un token inexistente da 404 con mensaje, no un 500 ni un caída al registro', async () => {
    const res = await pedir('/invitations/accept', `wos_${invitado}`, {
      token: 'token-que-no-existe-en-ninguna-parte',
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string; reason: string };
    expect(body.error).toContain('no existe o ya no es válida');
    // `reason` es lo que le permite al cliente decirlo en el idioma del usuario. El texto
    // en español viaja igual, de red — pero si el código desaparece, la pantalla que ve
    // un invitado angloparlante vuelve a contestarle en español.
    expect(body.reason).toBe('not_found');
  });

  test('un token filtrado no mete a CUALQUIER cuenta en la empresa', async () => {
    /*
     * El chequeo que de verdad autoriza, y la razón por la que aceptar por `invitationId`
     * no debilita nada: lo decisivo nunca fue tener el enlace, sino que el correo de la
     * invitación empate con el de la cuenta. Acá se presenta un token VÁLIDO desde una
     * cuenta que no es su destinataria.
     *
     * ═══ HALLAZGO (CU-868ktkq8r): CON `macha_app` NO SALE POR `wrong_recipient` ═══
     *
     * `rejectAcceptance` tiene una rama `wrong_recipient` (403) pensada exactamente para
     * esto, y bajo el rol de la app **no se alcanza nunca**: la política de RLS de 0017
     * solo deja ver una invitación por EMPRESA o por DESTINATARIO, así que para esta
     * cuenta la fila no existe y el rechazo sale antes, como `not_found` (404).
     *
     * Es más seguro, no menos — el modo de fallo es "no ve", que es justo lo que la 0017
     * buscaba —, pero tiene una consecuencia de producto que hay que tener presente y por
     * eso este test la fija: **al invitado que entró con otro correo no se le puede decir
     * "entra con el correo al que te llegó"**, porque el servidor no puede distinguir su
     * caso del de un token inventado sin convertir la tabla en un oráculo. De ahí que el
     * texto de `not_found` en el cliente nombre las tres posibilidades en vez de afirmar
     * que la invitación ya no sirve.
     */
    const tokenEnClaro = `token-de-otra-persona-${randomUUID()}`;
    await owner`
      insert into company_invitations
        (company_id, email, role, token_hash, invited_by_user_id, expires_at)
      values (${empresa}, ${'otro-' + randomUUID() + '@ejemplo.com'}, 'member',
              ${hashInvitationToken(tokenEnClaro)}, ${jefe}, now() + interval '7 days')
    `;

    const res = await pedir('/invitations/accept', `wos_${ajeno}`, { token: tokenEnClaro });
    expect(res.status).toBe(404);
    expect((await res.json()) as { reason: string }).toMatchObject({ reason: 'not_found' });

    // Lo que de verdad importa: no entró a la empresa.
    const filas = await owner`
      select 1 from company_users where company_id = ${empresa} and user_id = ${ajeno}
    `;
    expect(filas).toHaveLength(0);
  });
});
