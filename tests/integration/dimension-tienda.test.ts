import { describe, expect, test, beforeAll, afterAll } from 'bun:test';
import { drizzle } from 'drizzle-orm/postgres-js';
import { ownerConnection, setupTestDatabase } from './setup';
import * as schema from '@/db/schema';
import { StoreResolver } from '@/lib/store-dimension';
import { executeChatTool } from '@/lib/chat-tools';
import { promoteDocument } from '@/lib/promotion';
import type { DB } from '@/db/client';

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════
 * LA DIMENSIÓN TIENDA — CU-868kt8kk9
 * ═══════════════════════════════════════════════════════════════════════════════════════
 *
 * Macha reportó que la carga "no lee las tiendas" y que el asesor contesta que no tiene esa
 * información aunque el archivo sí la traiga. Verificado contra producción antes de tocar
 * nada:
 *
 * ```
 * stores:                     0 filas
 * transactions.store_id:      0 de 12 558
 * products:                 675 filas   ← la misma mecánica, funcionando
 * ```
 *
 * La tabla existía y `transactions.store_id` la referenciaba desde el data model. Lo que
 * faltaba era el camino intermedio: `ColumnMap` no tenía campo de tienda, así que la
 * columna del Excel se leía y se tiraba en cada carga.
 *
 * Se prueba contra Postgres real porque lo que puede fallar vive en la base: el índice
 * único sobre `lower(name)`, el aislamiento entre empresas y la agregación del ranking.
 */
describe('dimensión tienda', () => {
  let owner: ReturnType<typeof ownerConnection>;
  let db: DB;
  let companyId: string;
  let otra: string;
  let documentId: string;

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

    companyId = await crear('org_tiendas', 'Cadena Tiendas SA');
    otra = await crear('org_tiendas_b', 'Vecina Tiendas SA');

    const [u] = await owner`
      insert into users (workos_user_id, email)
      values ('wos_tiendas', 'tiendas@test.local') returning id`;
    // `review` y no un estado inventado: `documents_status_chk` restringe los valores, y
    // `review` es el estado en el que un documento tiene filas de staging esperando.
    const [d] = await owner`
      insert into documents (company_id, uploaded_by, s3_key, original_filename,
                             file_size_bytes, mime_type)
      values (${companyId}, ${u!.id}, ${`${companyId}/a`}, 'a.xlsx', 100, 'text/csv')
      returning id`;
    documentId = d!.id;
  });

  afterAll(async () => {
    await owner?.end();
  });

  test('crea la tienda la primera vez y la reusa después', async () => {
    const r = new StoreResolver(db, companyId);
    const a = await r.resolve('TDA-001');
    const b = await r.resolve('TDA-001');
    expect(a).toBe(b!);

    const [n] = await owner`select count(*)::int as n from stores where company_id = ${companyId}`;
    expect(n!.n).toBe(1);
  });

  test('la misma tienda con otra capitalización NO crea una segunda', async () => {
    /*
     * El mismo local aparece como "TDA-001", "Tda-001" y "tda-001" en el mismo archivo. Sin
     * normalizar, el ranking mostraría tres tiendas donde hay una y ninguna sería la que más
     * vendió — que es literalmente la pregunta del ticket.
     */
    const r = new StoreResolver(db, companyId);
    const a = await r.resolve('TDA-002');
    // Resolvedor NUEVO: sin caché, así que la deduplicación tiene que venir de la consulta.
    const b = await new StoreResolver(db, companyId).resolve('tda-002');
    expect(b).toBe(a!);

    const [n] = await owner`
      select count(*)::int as n from stores
      where company_id = ${companyId} and lower(name) = 'tda-002'`;
    expect(n!.n).toBe(1);
  });

  test('conserva la capitalización de la PRIMERA aparición', async () => {
    // Es la que el dueño reconoce. Buscar normalizado y guardar tal cual son cosas distintas.
    const [fila] = await owner`
      select name from stores where company_id = ${companyId} and lower(name) = 'tda-002'`;
    expect(fila!.name).toBe('TDA-002');
  });

  test('sin nombre NO inventa tienda', async () => {
    // Una venta sin tienda identificable queda con `store_id` nulo, que es la verdad.
    // Rellenarla con "Sin tienda" crearía una sucursal fantasma compitiendo en el ranking.
    const r = new StoreResolver(db, companyId);
    expect(await r.resolve(null)).toBeNull();
    expect(await r.resolve('')).toBeNull();
    expect(await r.resolve('   ')).toBeNull();
  });

  test('dos empresas pueden tener una tienda con el mismo nombre', async () => {
    // El índice único es `(company_id, lower(name))`. Que "TDA-001" de una empresa colisione
    // con la de otra sería una fuga entre inquilinos disfrazada de deduplicación.
    const mia = await new StoreResolver(db, companyId).resolve('TDA-001');
    const suya = await new StoreResolver(db, otra).resolve('TDA-001');
    expect(suya).not.toBe(mia);
  });

  test('la PROMOCIÓN asocia la tienda del payload a la transacción', async () => {
    /*
     * El camino que de verdad importa y el que el ticket describe: la columna del Excel
     * llega al payload, la promoción la resuelve y la transacción queda con su `store_id`.
     *
     * Los otros tests insertan transacciones directo, así que verifican el resolvedor y la
     * consulta del asesor pero SALTAN este cableado — y sin él, todo lo demás funcionaría y
     * la tienda seguiría sin llegar a la base, que es exactamente el bug reportado.
     */
    // `review` y no un estado inventado: `documents_status_chk` restringe los valores, y
    // `review` es el estado en el que un documento tiene filas de staging esperando.
    const [d] = await owner`
      insert into documents (company_id, uploaded_by, s3_key, original_filename,
                             file_size_bytes, mime_type, status)
      select ${companyId}, uploaded_by, ${`${companyId}/prom`}, 'prom.xlsx', 100, 'text/csv', 'review'
      from documents where id = ${documentId}
      returning id`;
    const doc = d!.id as string;

    for (const [tienda, monto] of [
      ['TDA-PROM-A', 300],
      ['TDA-PROM-B', 200],
    ] as const) {
      await owner`
        insert into staging_rows (company_id, document_id, target_entity, confidence, payload, review_status)
        values (${companyId}, ${doc}, 'transaction', 0.95,
          ${JSON.stringify({
            type: 'revenue',
            category: 'ventas',
            date: '2026-07-20',
            originalAmount: monto,
            originalCurrency: 'GTQ',
            store: tienda,
          })}::jsonb, 'approved')`;
    }

    await promoteDocument(db, companyId, doc);

    const filas = await owner`
      select s.name as tienda, t.amount_base
      from transactions t join stores s on s.id = t.store_id
      where t.document_id = ${doc} order by s.name`;

    expect(filas.map((f) => f.tienda)).toEqual(['TDA-PROM-A', 'TDA-PROM-B']);
  });

  describe('el asesor puede responder por tienda', () => {
    beforeAll(async () => {
      const venta = async (tienda: string | null, monto: number) => {
        const storeId = tienda ? await new StoreResolver(db, companyId).resolve(tienda) : null;
        await owner`
          insert into transactions (company_id, document_id, type, category, date,
                                    original_amount, original_currency, amount_base,
                                    fx_rate, fx_rate_date, store_id)
          values (${companyId}, ${documentId}, 'revenue', 'ventas', '2026-07-10',
                  ${monto}, 'GTQ', ${monto}, 1, '2026-07-10', ${storeId})`;
      };
      await venta('TDA-001', 1000);
      await venta('TDA-001', 500);
      await venta('TDA-002', 800);
      // Una venta SIN tienda: no debe aparecer como un local más.
      await venta(null, 9999);
    });

    test('rankea las tiendas por ventas, sumando en SQL', async () => {
      const salida = await executeChatTool({ db, companyId }, 'get_sales_by_store', {});
      const filas = JSON.parse(salida) as Array<{ tienda: string; ventas: number }>;

      expect(filas[0]).toMatchObject({ tienda: 'TDA-001', ventas: 1500 });
      expect(filas[1]).toMatchObject({ tienda: 'TDA-002', ventas: 800 });
    });

    test('la venta SIN tienda no aparece como un local', async () => {
      /*
       * Agruparla bajo una etiqueta inventada pondría al "desconocido" —9 999, la venta más
       * grande— en el PRIMER puesto del ranking de sucursales del cliente.
       *
       * Se afirma la ausencia de ese monto y no un conteo fijo de filas: el conteo dependería
       * de qué tiendas crearon los otros tests de este archivo, y un test que se rompe cuando
       * un vecino agrega un fixture no está midiendo lo que dice medir.
       */
      const filas = JSON.parse(
        await executeChatTool({ db, companyId }, 'get_sales_by_store', {}),
      ) as Array<{ tienda: string; ventas: number }>;

      expect(filas.some((f) => f.ventas === 9999)).toBe(false);
      // Y toda fila del ranking tiene nombre de tienda de verdad, ninguna es un marcador.
      for (const f of filas) expect(f.tienda.trim().length).toBeGreaterThan(0);
    });

    test('respeta el rango de fechas', async () => {
      const vacio = await executeChatTool({ db, companyId }, 'get_sales_by_store', {
        dateFrom: '2026-01-01',
        dateTo: '2026-01-31',
      });
      expect(vacio).toMatch(/no traía una columna de tienda|No hay ventas/i);
    });

    test('sin tiendas, el mensaje DICE por qué — no "no tengo esa información"', async () => {
      /*
       * El reporte del ticket es que el asesor contesta "no tengo esa información". Si la
       * herramienta devolviera una lista vacía a secas, volvería a contestar lo mismo.
       * Distinguir "tu archivo no traía tiendas" de "no puedo consultarlo" es lo que
       * convierte una respuesta inútil en una accionable.
       */
      const salida = await executeChatTool({ db, companyId: otra }, 'get_sales_by_store', {});
      expect(salida).toContain('no traía una columna de tienda');
    });
  });
});
