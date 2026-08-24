import { describe, expect, test, beforeAll, afterAll } from 'bun:test';
import { drizzle } from 'drizzle-orm/postgres-js';
import { ownerConnection, setupTestDatabase } from './setup';
import * as schema from '@/db/schema';
import { currencyComposition } from '@/modules/metrics/currencies';
import type { DB } from '@/db/client';

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════
 * COMPOSICIÓN POR MONEDA Y TASA APLICADA — CU-868kj3gnv
 * ═══════════════════════════════════════════════════════════════════════════════════════
 *
 * Va contra Postgres real porque todo lo que puede fallar vive en la consulta: el `group by`
 * por moneda original, el min/max de la tasa y —lo más fácil de equivocar— la tasa MÁS
 * RECIENTE, que no es `max(fx_rate)` sino la de la fecha mayor.
 *
 * Las tasas son distintas entre sí a propósito y ninguna es "redonda": si el código tomara la
 * mayor en vez de la última, el test lo dice con un número concreto en vez de pasar por
 * casualidad.
 */
describe('composición por moneda', () => {
  let owner: ReturnType<typeof ownerConnection>;
  let db: DB;
  let mixta: string;
  let soloQuetzales: string;

  beforeAll(async () => {
    await setupTestDatabase();
    owner = ownerConnection();
    db = drizzle(owner, { schema }) as unknown as DB;

    const crear = async (org: string, nombre: string): Promise<string> => {
      const [c] = await owner`
        insert into companies (workos_org_id, name, industry, base_currency)
        values (${org}, ${nombre}, 'retail', 'GTQ') returning id`;
      const id = c!.id as string;
      await owner.unsafe(
        `create table if not exists "transactions_${id.replace(/-/g, '_')}"
           partition of transactions for values in ('${id}')`,
      );
      return id;
    };

    mixta = await crear('org_fx_mixta', 'Mixta SA');
    soloQuetzales = await crear('org_fx_gtq', 'Solo Quetzales SA');

    const [u] = await owner`
      insert into users (workos_user_id, email)
      values ('wos_composicion_moneda', 'composicion-moneda@test.local') returning id`;

    const docDe = async (empresa: string): Promise<string> => {
      const [d] = await owner`
        insert into documents (company_id, uploaded_by, s3_key, original_filename,
                               file_size_bytes, mime_type)
        values (${empresa}, ${u!.id}, ${`${empresa}/a`}, 'a.xlsx', 100, 'text/csv')
        returning id`;
      return d!.id;
    };
    const docMixta = await docDe(mixta);
    const docGtq = await docDe(soloQuetzales);

    const mov = async (
      empresa: string,
      documentId: string,
      moneda: 'GTQ' | 'USD',
      original: number,
      tasa: number,
      fecha: string,
      borrada = false,
    ) => {
      await owner`
        insert into transactions (company_id, document_id, type, category, date,
                                  original_amount, original_currency, amount_base,
                                  fx_rate, fx_rate_date, deleted_at)
        values (${empresa}, ${documentId}, 'revenue', 'ventas', ${fecha},
                ${original}, ${moneda}, ${original * tasa}, ${tasa}, ${fecha},
                ${borrada ? owner`now()` : null})`;
    };

    // Julio, empresa mixta:
    //   GTQ: 1.000 + 500 = 1.500 (tasa 1)
    //   USD:   100 @ 7.61  =   761
    //          200 @ 7.83  = 1.566   ← tasa MÁS ALTA, pero NO la más reciente
    //          300 @ 7.72  = 2.316   ← la MÁS RECIENTE (31/07)
    //   USD original total = 600 · base = 4.643
    await mov(mixta, docMixta, 'GTQ', 1000, 1, '2026-07-05');
    await mov(mixta, docMixta, 'GTQ', 500, 1, '2026-07-06');
    await mov(mixta, docMixta, 'USD', 100, 7.61, '2026-07-10');
    await mov(mixta, docMixta, 'USD', 200, 7.83, '2026-07-20');
    await mov(mixta, docMixta, 'USD', 300, 7.72, '2026-07-31');
    // Borrada: con monto a gritos por si el filtro falla.
    await mov(mixta, docMixta, 'USD', 900_000, 7.5, '2026-07-15', true);
    // Agosto: solo quetzales, para probar que el rango cambia el veredicto multi-moneda.
    await mov(mixta, docMixta, 'GTQ', 250, 1, '2026-08-04');

    await mov(soloQuetzales, docGtq, 'GTQ', 4200, 1, '2026-07-05');
  });

  afterAll(async () => {
    await owner?.end();
  });

  const julio = (empresa: string) =>
    currencyComposition(db, empresa, 'GTQ', '2026-07-01', '2026-07-31');

  test('agrupa por moneda ORIGINAL y no mezcla los totales', async () => {
    const { rows } = await julio(mixta);
    const usd = rows.find((r) => r.currency === 'USD')!;
    const gtq = rows.find((r) => r.currency === 'GTQ')!;

    // 600 dólares son 600 dólares: `originalTotal` NUNCA se convierte.
    expect(usd.originalTotal).toBeCloseTo(600, 6);
    expect(usd.baseTotal).toBeCloseTo(761 + 1566 + 2316, 6);
    expect(usd.transactionCount).toBe(3);
    expect(gtq.originalTotal).toBeCloseTo(1500, 6);
    expect(gtq.baseTotal).toBeCloseTo(1500, 6);
  });

  test('la tasa "última" es la de la FECHA mayor, no la tasa más alta', async () => {
    /*
     * El error que este test existe para atrapar: `max(fx_rate)` daría 7,83 —la tasa más
     * alta del período, del 20 de julio— y la interfaz escribiría "tasa aplicada 7,83 al 31
     * de julio", que es una fecha con la tasa de otro día. Plausible, y mal.
     */
    const { rows } = await julio(mixta);
    const usd = rows.find((r) => r.currency === 'USD')!;

    expect(usd.rate!.latest).toBeCloseTo(7.72, 6);
    expect(usd.rate!.latestDate).toBe('2026-07-31');
    expect(usd.rate!.max).toBeCloseTo(7.83, 6);
    expect(usd.rate!.min).toBeCloseTo(7.61, 6);
  });

  test('la moneda BASE no reporta tasa: sería siempre 1 y solo ruido', async () => {
    const { rows } = await julio(mixta);
    expect(rows.find((r) => r.currency === 'GTQ')!.rate).toBeNull();
  });

  test('min ≠ max avisa de que el consolidado NO se reproduce con una regla de tres', async () => {
    /*
     * Es la razón de devolver un rango y no un número. Con tres tasas distintas en el mes,
     * 600 USD no son `600 × 7,72`: son 4.643, y ninguna tasa sola lo explica. Si la interfaz
     * mostrara una tasa a secas, el cliente que multiplicara no cuadraría y pensaría que el
     * dashboard está mal.
     */
    const usd = (await julio(mixta)).rows.find((r) => r.currency === 'USD')!;
    expect(usd.rate!.min).not.toBeCloseTo(usd.rate!.max, 6);
    expect(usd.originalTotal * usd.rate!.latest).not.toBeCloseTo(usd.baseTotal, 2);
  });

  test('las borradas no cuentan, ni en el total ni en el rango de tasas', async () => {
    // La borrada lleva tasa 7,5: si contara, `min` sería 7,5 en vez de 7,61.
    const usd = (await julio(mixta)).rows.find((r) => r.currency === 'USD')!;
    expect(usd.originalTotal).toBeCloseTo(600, 6);
    expect(usd.rate!.min).toBeCloseTo(7.61, 6);
  });

  test('una empresa de una sola moneda NO es multi-moneda', async () => {
    // Criterio 4 del ticket: sin esto, el dashboard le pinta un control de moneda a la
    // inmensa mayoría de los clientes, que operan solo en quetzales.
    const solo = await julio(soloQuetzales);
    expect(solo.multiCurrency).toBe(false);
    expect(solo.rows).toHaveLength(1);
  });

  test('el veredicto multi-moneda se evalúa POR PERÍODO, no por empresa', async () => {
    /*
     * La misma empresa mixta, en agosto, solo tuvo quetzales. El control no debe aparecer:
     * no hay segunda moneda que mostrar en ESE período, y pintarlo abriría un desglose de
     * una sola fila.
     */
    expect((await julio(mixta)).multiCurrency).toBe(true);

    const agosto = await currencyComposition(db, mixta, 'GTQ', '2026-08-01', '2026-08-31');
    expect(agosto.multiCurrency).toBe(false);
  });

  test('un período sin movimientos devuelve lista vacía, no revienta', async () => {
    const vacio = await currencyComposition(db, mixta, 'GTQ', '2020-01-01', '2020-01-31');
    expect(vacio.rows).toEqual([]);
    expect(vacio.multiCurrency).toBe(false);
  });
});
