import { describe, expect, test, beforeAll, afterAll } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/postgres-js';
import { ownerConnection, setupTestDatabase } from './setup';
import * as schema from '@/db/schema';
import { promoteDocument } from '@/lib/promotion';
import { insertStagingRows } from '@/lib/staging';
import { LIBROS } from '@/lib/hostiles/libros';
import { correrPipeline } from '@/lib/hostiles/pipeline-doble';
import type { DB } from '@/db/client';

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LOS DIEZ LIBROS MAL HECHOS, HASTA LA CIFRA DEL DASHBOARD
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *
 * `src/lib/hostiles-e2e.test.ts` corre los mismos diez contra el pipeline en memoria, que es
 * rápido y cubre las decisiones. Lo que NO puede cubrir es lo que calcula Postgres: la
 * conversión de moneda al promover, las particiones por empresa, `staging-rules` sobre filas
 * de verdad, la promoción parcial y la suma que el dashboard hace por tipo.
 *
 * Los siete reportes de ingesta que llegaron de clientes tenían todos la misma forma —cada
 * etapa correcta y la cifra final mal—, así que la afirmación que vale es la de la punta:
 * **lo que el cliente ve tiene que ser lo que trae su archivo.**
 */
describe('los libros hostiles llegan enteros al dashboard', () => {
  let owner: ReturnType<typeof ownerConnection>;
  let db: DB;
  let empresa: string;
  let usuario: string;

  beforeAll(async () => {
    await setupTestDatabase();
    owner = ownerConnection();
    db = drizzle(owner, { schema }) as unknown as DB;

    const sufijo = randomUUID();
    const [c] = await owner`
      insert into companies (workos_org_id, name, industry, base_currency)
      values (${`org_hostiles_${sufijo}`}, ${`E2E Hostiles ${sufijo}`}, 'retail', 'GTQ')
      returning id`;
    empresa = c!.id as string;
    for (const t of ['transactions', 'invoices', 'bills']) {
      await owner.unsafe(
        `create table if not exists "${t}_${empresa.replace(/-/g, '_')}"
           partition of ${t} for values in ('${empresa}')`,
      );
    }
    const [u] = await owner`
      insert into users (workos_user_id, email)
      values (${`wos_hostiles_${sufijo}`}, ${`hostiles_${sufijo}@test.local`}) returning id`;
    usuario = u!.id as string;

    /*
     * La tasa USD→GTQ tiene que existir ANTES de promover: `amount_base` se calcula con la
     * tasa vigente a la fecha de la fila y se snapshotea ahí. Sin ella el libro 10 —que trae
     * facturación en dólares— no podría afirmar ni una cifra.
     */
    await owner`
      insert into fx_rates (company_id, base_currency, quote_currency, rate, effective_date)
      values (${empresa}, 'GTQ', 'USD', 7.7, '2020-01-01')
      on conflict do nothing`;
  });

  afterAll(async () => {
    await owner?.end();
  });

  /** Suma por tipo tal como la hace el dashboard: `transactions.amount_base` agrupado. */
  async function dashboard(): Promise<Record<string, number>> {
    const filas = await owner`
      select type, coalesce(sum(amount_base), 0)::float8 as total
      from transactions where company_id = ${empresa} and deleted_at is null
      group by type`;
    const out: Record<string, number> = { revenue: 0, cogs: 0, opex: 0, other: 0 };
    for (const f of filas) out[f.type as string] = f.total as number;
    return out;
  }

  for (const fabricar of LIBROS) {
    const libro = fabricar();

    test(`${libro.archivo} — el dashboard muestra lo que trae el archivo`, async () => {
      const antes = await dashboard();
      const corrida = correrPipeline(libro);

      /*
       * Un documento por HOJA, igual que el worker: cada hoja produce su propio lote de filas
       * de staging y la promoción es por documento.
       */
      const documentos: string[] = [];
      for (const hoja of corrida.porHoja) {
        if (hoja.clasificadas.length === 0) continue;
        const [d] = await owner`
          insert into documents (company_id, uploaded_by, s3_key, original_filename,
                                 file_size_bytes, mime_type)
          values (${empresa}, ${usuario}, ${`${empresa}/${randomUUID()}`},
                  ${`${libro.archivo}#${hoja.nombre}`}, 1000,
                  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
          returning id`;
        const documentId = d!.id as string;
        documentos.push(documentId);
        await insertStagingRows(db, empresa, documentId, hoja.clasificadas as never);
        await promoteDocument(db, empresa, documentId);
      }

      const despues = await dashboard();
      const delta = {
        revenue: Math.round((despues.revenue! - antes.revenue!) * 100) / 100,
        cogs: Math.round((despues.cogs! - antes.cogs!) * 100) / 100,
        opex: Math.round((despues.opex! - antes.opex!) * 100) / 100,
      };

      // Se compara el objeto entero: si falla, el mensaje dice las tres cifras de una vez.
      expect(delta).toEqual({
        revenue: libro.verdad.revenue,
        cogs: libro.verdad.cogs,
        opex: libro.verdad.opex,
      });

      /*
       * Y las filas marcadas siguen siendo las que no se pueden leer, contadas en la BASE y
       * no en memoria: `staging-rules` corre dentro de `insertStagingRows`, así que este
       * conteo es el que vería el equipo en la cola de revisión.
       */
      const [m] = await owner`
        select count(*)::int as n from staging_rows
        where company_id = ${empresa} and document_id = any(${documentos})
          and flag_reason is not null`;
      expect(m!.n as number).toBe(libro.marcadas ?? 0);
    });
  }
});
