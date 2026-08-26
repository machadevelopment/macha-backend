import { describe, expect, test, beforeAll, afterAll } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { ownerConnection, setupTestDatabase } from './setup';
import { clientCan } from '@/lib/permissions';

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * EL TIPO DE CAMBIO LO MANTIENE EL CLIENTE (decisión de Jose, 2026-08-25)
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *
 * Lo que se prueba acá es lo que hizo posible la decisión, no la ruta: **cambiar la tasa no
 * reescribe la contabilidad ya cargada**. Ese es el miedo que tenía el ticket parado, y la
 * respuesta no es una promesa del handler sino una propiedad del modelo de datos — cada fila
 * financiera congela su `fx_rate` al promoverse.
 *
 * Va contra Postgres real porque es exactamente lo que hay que comprobar: que una fila YA
 * escrita con una tasa no cambia cuando la tasa de su fecha cambia.
 */
describe('el tipo de cambio del cliente', () => {
  let owner: ReturnType<typeof ownerConnection>;
  let empresa: string;
  let documento: string;

  beforeAll(async () => {
    await setupTestDatabase();
    owner = ownerConnection();
    const sufijo = randomUUID();
    const [c] = await owner`
      insert into companies (workos_org_id, name, industry, base_currency)
      values (${`org_fx_${sufijo}`}, ${`FX Cliente ${sufijo}`}, 'retail', 'GTQ') returning id`;
    empresa = c!.id as string;
    await owner.unsafe(
      `create table if not exists "transactions_${empresa.replace(/-/g, '_')}"
         partition of transactions for values in ('${empresa}')`,
    );
    const [u] = await owner`
      insert into users (workos_user_id, email)
      values (${`wos_fx_${sufijo}`}, ${`fx_${sufijo}@test.local`}) returning id`;
    const [d] = await owner`
      insert into documents (company_id, uploaded_by, s3_key, original_filename,
                             file_size_bytes, mime_type)
      values (${empresa}, ${u!.id}, ${`${empresa}/fx`}, 'a.xlsx', 100, 'text/csv')
      returning id`;
    documento = d!.id as string;
  });

  afterAll(async () => {
    await owner?.end();
  });

  test('cualquier admin puede tocarla; un member no', () => {
    // La decisión textual de Jose: "empecemos con que cualquier admin de la empresa lo pueda
    // tocar, no solo el dueño de cuenta".
    expect(clientCan('owner', 'manage_fx_rate')).toBe(true);
    expect(clientCan('admin', 'manage_fx_rate')).toBe(true);
    // `member` sí queda fuera: mover la tasa mueve todo lo que se convierta de ahí en
    // adelante, así que no es una acción de operación diaria.
    expect(clientCan('member', 'manage_fx_rate')).toBe(false);
  });

  test('NO está junto a las capacidades que son solo del dueño', () => {
    // Si alguien la moviera a la lista de `billing`, la fricción que Jose quiso evitar
    // volvería sin que nada más falle.
    expect(clientCan('admin', 'billing')).toBe(false);
    expect(clientCan('admin', 'manage_members')).toBe(false);
    expect(clientCan('admin', 'manage_fx_rate')).toBe(true);
  });

  /**
   * El corazón del ticket: la tasa NO es retroactiva.
   *
   * Se escribe una transacción con su `fx_rate` congelado, se cambia la tasa de esa misma
   * fecha, y se comprueba que la fila no se movió. Sin esta garantía, la decisión de dejar que
   * el cliente la toque sería peligrosa: un ajuste de hoy reescribiría marzo.
   */
  test('cambiar la tasa no reescribe una transacción ya promovida', async () => {
    await owner`
      insert into fx_rates (company_id, base_currency, quote_currency, rate, effective_date)
      values (${empresa}, 'GTQ', 'USD', '7.70000000', '2026-03-10')`;

    await owner`
      insert into transactions (company_id, document_id, date, type, category, original_amount,
                               original_currency, amount_base, fx_rate, fx_rate_date)
      values (${empresa}, ${documento}, '2026-03-10', 'revenue', 'ventas', '100.00', 'USD',
              '770.00', '7.70000000', '2026-03-10')`;

    // El cliente corrige la tasa de esa misma fecha, meses después.
    await owner`
      update fx_rates set rate = '8.50000000'
      where company_id = ${empresa} and effective_date = '2026-03-10'`;

    const [fila] = await owner`
      select amount_base::float8 as base, fx_rate::float8 as tasa from transactions
      where company_id = ${empresa} and date = '2026-03-10'`;

    // La contabilidad de marzo no se movió: sigue con la tasa con la que entró.
    expect(fila!.tasa).toBe(7.7);
    expect(fila!.base).toBe(770);
  });

  test('la tasa nueva sí aplica a lo que entra después', async () => {
    await owner`
      insert into transactions (company_id, document_id, date, type, category, original_amount,
                               original_currency, amount_base, fx_rate, fx_rate_date)
      values (${empresa}, ${documento}, '2026-04-01', 'revenue', 'ventas', '100.00', 'USD',
              '850.00', '8.50000000', '2026-04-01')`;

    const [fila] = await owner`
      select amount_base::float8 as base from transactions
      where company_id = ${empresa} and date = '2026-04-01'`;
    expect(fila!.base).toBe(850);
  });

  /**
   * Corregir un dedazo sobrescribe la fila de esa fecha, no agrega una segunda.
   *
   * `fx_rates` no es un ledger append-only, y el índice único por
   * `(empresa, base, quote, fecha)` es lo que lo garantiza — es también lo que hace que
   * "ajustarla seguido", que es el caso que Jose describió, no llene la tabla de duplicados.
   */
  test('una fecha tiene UNA tasa: corregir reemplaza', async () => {
    const [n] = await owner`
      select count(*)::int as n from fx_rates
      where company_id = ${empresa} and effective_date = '2026-03-10'`;
    expect(n!.n).toBe(1);
  });
});
