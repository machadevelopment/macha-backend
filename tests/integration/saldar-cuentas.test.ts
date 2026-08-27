import { describe, expect, test, beforeAll, afterAll, mock } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { ownerConnection, setupTestDatabase, testAppUrl, testOwnerUrl } from './setup';

// El env va ANTES de importar nada que lea `env`: `lib/env` lo evalúa en el import y
// `db/client` abre el pool ahí mismo.
process.env.DATABASE_URL = testOwnerUrl;
process.env.APP_DATABASE_URL = testAppUrl;
process.env.WORKOS_JWKS_URL = 'https://example.invalid/jwks';

/** El "token" es literalmente el `workos_user_id` — alcanza para ejercitar el guard. */
mock.module('@/lib/auth', () => ({
  verifyToken: async (token: string) => ({ sub: token }),
}));

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * DAR POR SALDADA UNA CUENTA, Y QUE SALGA DEL BALANCE ABIERTO — CU-868kx4cr6
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *
 * Jose: *"si ya está pagada, se debería restar del balance abierto. Actualmente sale el capital
 * completo de las cuentas aunque ya están pagadas."*
 *
 * El cálculo nunca estuvo mal: `GET /ar-ap` ya filtraba `status = 'open'`. Lo que no existía era
 * **algo que escribiera `paid` alguna vez** — ni endpoint, ni botón, ni proceso. La columna
 * estaba declarada y nadie la tocaba nunca.
 *
 * ═══ POR QUÉ CONTRA POSTGRES DE VERDAD, Y CON EL ROL DE LA APP ═══
 *
 * Porque lo que hay que demostrar es que el UPDATE **puede ejecutarse**, y eso depende de tres
 * cosas que solo existen del lado de la base: que `macha_app` tenga UPDATE sobre la partición
 * de esa empresa (la migración 0002 hace `REVOKE UPDATE, DELETE ... FROM PUBLIC` sobre cada
 * una), que la política de RLS deje tocar la fila, y que el `where` acierte con una PK
 * compuesta `(company_id, id)`. Con un doble del cliente los tres quedan sin probar y el test
 * pasaría en verde con el producto roto en producción.
 */
describe('saldar una cuenta por cobrar o por pagar', () => {
  let owner: ReturnType<typeof ownerConnection>;
  /*
   * La app se construye UNA vez en `beforeAll`, no en cada petición.
   *
   * La primera versión llamaba a `createApp()` dentro de `pedir`, o sea que cada request
   * recomponía los ~30 plugins de Elysia desde cero. Local pasaba; **en CI un test de tres
   * peticiones se pasó de los 5 s de plazo** y el PR quedó en rojo por algo que no tenía nada
   * que ver con lo que prueba. Montar la app es caro y no es lo que este archivo verifica.
   */
  let app: ReturnType<typeof import('@/app').createApp>;
  const empresa = randomUUID();
  const otraEmpresa = randomUUID();
  const usuario = randomUUID();
  const documento = randomUUID();
  let facturaGrande: string;
  let facturaChica: string;
  let cuentaPorPagar: string;

  const pedir = (ruta: string, init?: RequestInit) =>
    app.handle(
      new Request(`http://localhost${ruta}`, {
        ...init,
        headers: {
          authorization: `Bearer wos_${usuario}`,
          'x-company-id': empresa,
          ...(init?.body ? { 'content-type': 'application/json' } : {}),
          ...(init?.headers ?? {}),
        },
      }),
    );

  beforeAll(async () => {
    await setupTestDatabase();
    owner = ownerConnection();
    app = (await import('@/app')).createApp();

    for (const id of [empresa, otraEmpresa]) {
      await owner`
        insert into companies (id, workos_org_id, name, industry, base_currency, locale)
        values (${id}, ${'org_' + id}, ${'Saldar ' + id}, 'retail', 'GTQ', 'es')`;
      // Las particiones por empresa se crean al aprovisionar, no en una migración global.
      const suf = id.replace(/-/g, '_');
      for (const tabla of ['invoices', 'bills', 'transactions']) {
        await owner.unsafe(
          `create table if not exists "${tabla}_${suf}" partition of ${tabla} for values in ('${id}')`,
        );
        await owner.unsafe(
          `grant select, insert, update, delete on "${tabla}_${suf}" to macha_app`,
        );
      }
    }
    await owner`
      insert into users (id, workos_user_id, email)
      values (${usuario}, ${'wos_' + usuario}, ${'saldar-' + usuario + '@ejemplo.com'})`;
    await owner`
      insert into company_users (company_id, user_id, role, status)
      values (${empresa}, ${usuario}, 'member', 'active')`;
    await owner`
      insert into documents (company_id, uploaded_by, s3_key, original_filename,
                             file_size_bytes, mime_type)
      values (${empresa}, ${usuario}, ${empresa + '/x'}, 'a.xlsx', 10, 'text/csv')
      returning id`.then(async ([d]) => {
      await owner`
        insert into invoices (id, company_id, document_id, counterparty, issue_date, due_date,
                              original_amount, original_currency, amount_base, fx_rate,
                              fx_rate_date)
        values (${(facturaGrande = randomUUID())}, ${empresa}, ${d!.id}, 'Cliente A',
                '2026-07-01', '2026-07-31', 1000, 'GTQ', 1000, 1, '2026-07-01'),
               (${(facturaChica = randomUUID())}, ${empresa}, ${d!.id}, 'Cliente B',
                '2026-07-05', '2026-08-04', 250, 'GTQ', 250, 1, '2026-07-05')`;
      await owner`
        insert into bills (id, company_id, document_id, counterparty, issue_date, due_date,
                           original_amount, original_currency, amount_base, fx_rate, fx_rate_date)
        values (${(cuentaPorPagar = randomUUID())}, ${empresa}, ${d!.id}, 'Proveedor Z',
                '2026-07-02', '2026-08-01', 400, 'GTQ', 400, 1, '2026-07-02')`;
    });
    void documento;
  });

  afterAll(async () => {
    await owner?.end({ timeout: 5 }).catch(() => {});
  });

  const abiertoAr = async () => {
    const res = await pedir('/ar-ap');
    const body = (await res.json()) as { ar: Record<string, number> };
    return Object.values(body.ar).reduce((s, n) => s + Number(n), 0);
  };

  test('el listado trae las cuentas abiertas, lo más vencido primero', async () => {
    const res = await pedir('/receivables/ar?status=open');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rows: Array<{ id: string; counterparty: string }> };
    expect(body.rows).toHaveLength(2);
    // Vence el 31/07 contra el 04/08: cobrar empieza por lo más viejo.
    expect(body.rows[0]!.counterparty).toBe('Cliente A');
  });

  /*
   * EL CASO DEL TICKET, y se mide de la única forma que le importa a Jose: el total ANTES y
   * DESPUÉS. Afirmar que la columna quedó en `paid` probaría el UPDATE; esto prueba lo que él
   * reportó, que es que el balance abierto no se movía.
   */
  test('marcarla como pagada la resta del balance abierto', async () => {
    expect(await abiertoAr()).toBeCloseTo(1250, 2);

    const res = await pedir(`/receivables/ar/${facturaGrande}`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'paid' }),
    });
    expect(res.status).toBe(200);

    expect(await abiertoAr()).toBeCloseTo(250, 2);

    /*
     * Y la que queda abierta es la OTRA, no cualquiera que sume 250. Sin esta comprobación, un
     * `where` que tocara la fila equivocada daría el mismo total y el test pasaría igual — que
     * es exactamente el modo de fallo de una PK compuesta mal filtrada.
     */
    const abiertas = await pedir('/receivables/ar?status=open');
    const { rows } = (await abiertas.json()) as { rows: Array<{ id: string }> };
    expect(rows.map((r) => r.id)).toEqual([facturaChica]);
  });

  /*
   * Y se puede deshacer. Marcar la factura equivocada es el error más probable de esta pantalla
   * —filas parecidas, mismo cliente, montos similares— y sin vuelta atrás la única salida sería
   * revertir la carga entera.
   */
  test('y se puede volver atrás, devolviéndola al balance', async () => {
    const res = await pedir(`/receivables/ar/${facturaGrande}`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'open' }),
    });
    expect(res.status).toBe(200);
    expect(await abiertoAr()).toBeCloseTo(1250, 2);
  });

  test('lo mismo aplica a las cuentas por PAGAR', async () => {
    const antes = await pedir('/ar-ap').then(async (r) => {
      const b = (await r.json()) as { ap: Record<string, number> };
      return Object.values(b.ap).reduce((s, n) => s + Number(n), 0);
    });
    expect(antes).toBeCloseTo(400, 2);

    await pedir(`/receivables/ap/${cuentaPorPagar}`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'paid' }),
    });

    const despues = await pedir('/ar-ap').then(async (r) => {
      const b = (await r.json()) as { ap: Record<string, number> };
      return Object.values(b.ap).reduce((s, n) => s + Number(n), 0);
    });
    expect(despues).toBeCloseTo(0, 2);
  });

  /*
   * El candado de aislamiento. La PK es compuesta `(company_id, id)`: un `where` que solo mire
   * el `id` tocaría la fila homónima de otra empresa. Se pide una cuenta que existe pero es de
   * OTRA empresa y tiene que dar 404, no cambiarla.
   */
  test('no se puede saldar la cuenta de otra empresa', async () => {
    const ajena = randomUUID();
    const [d] = await owner`
      insert into documents (company_id, uploaded_by, s3_key, original_filename,
                             file_size_bytes, mime_type)
      values (${otraEmpresa}, ${usuario}, ${otraEmpresa + '/x'}, 'b.xlsx', 10, 'text/csv')
      returning id`;
    await owner`
      insert into invoices (id, company_id, document_id, counterparty, issue_date, due_date,
                            original_amount, original_currency, amount_base, fx_rate, fx_rate_date)
      values (${ajena}, ${otraEmpresa}, ${d!.id}, 'Ajeno', '2026-07-01', '2026-07-31',
              9999, 'GTQ', 9999, 1, '2026-07-01')`;

    const res = await pedir(`/receivables/ar/${ajena}`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'paid' }),
    });
    expect(res.status).toBe(404);

    const [sigue] = await owner`
      select status from invoices where company_id = ${otraEmpresa} and id = ${ajena}`;
    expect(sigue!.status).toBe('open');
  });
});
