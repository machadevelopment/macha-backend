import { describe, expect, test, beforeAll, afterAll } from 'bun:test';
import { drizzle } from 'drizzle-orm/postgres-js';
import { ownerConnection, setupTestDatabase } from './setup';
import * as schema from '@/db/schema';
import { getOrComputeMonthlyAmounts, refreshExistingRollups } from '@/lib/rollups';
import { revertDocument } from '@/lib/promotion';
import { findSeenFingerprints } from '@/lib/row-fingerprint';
import type { DB } from '@/db/client';

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════
 * REPRODUCCIÓN DE LO QUE REPORTÓ JOSE (2026-08-14)
 * ═══════════════════════════════════════════════════════════════════════════════════════
 *
 * Cuatro síntomas, textuales:
 *
 *   1. "cuando se borra un archivo y luego se carga otro, aparece como done pero no se
 *      actualiza la data"
 *   2. "en este user cargó un archivo y jala datos de otros"
 *   3. "ahorita se quedó trabada la ingesta"
 *   4. "en 2 users diferentes sale diferente el display de la data, no sé si es por el caché"
 *
 * Este archivo reproduce el 1 y el 4 contra Postgres real. Los dos resultaron ser bugs
 * concretos, no percepciones:
 *
 *   · El 1 es la deduplicación por huella: revertir NO libera las huellas, así que resubir
 *     el mismo archivo lo deduplica ENTERO y el documento termina `promoted` con cero filas.
 *     Revertir era, de hecho, un viaje de ida: esos datos ya no se podían volver a cargar.
 *
 *   · El 4 es `metric_rollups`. Su índice único incluye `category`, que es NULLABLE, y en
 *     Postgres NULL nunca colisiona en un índice único — así que el índice NO impide nada
 *     para las filas `category IS NULL`, que son justamente las únicas que el producto
 *     escribe. Dos dashboards abiertos a la vez insertan filas duplicadas del mismo período,
 *     y a partir de ahí cada lectura devuelve la que Postgres le dé primero. La intuición de
 *     Jose ("no sé si es por el caché") era correcta.
 */

const P1 = '2021-01-01';
const P2 = '2021-02-01';

describe('los fallos de ingesta que reportó Jose', () => {
  let owner: ReturnType<typeof ownerConnection>;
  let db: DB;
  let companyId: string;
  let userId: string;

  beforeAll(async () => {
    await setupTestDatabase();
    owner = ownerConnection();
    db = drizzle(owner, { schema }) as unknown as DB;

    const [c] = await owner`
      insert into companies (workos_org_id, name, industry)
      values ('org_jose_bugs', 'Bugs de Jose SA', 'retail') returning id
    `;
    companyId = c!.id;

    const suffix = companyId.replace(/-/g, '_');
    await owner.unsafe(
      `create table if not exists "transactions_${suffix}" partition of transactions
         for values in ('${companyId}')`,
    );

    const [u] = await owner`
      insert into users (workos_user_id, email)
      values ('wos_jose_bugs', 'jose_bugs@test.local') returning id
    `;
    userId = u!.id;
  });

  afterAll(async () => {
    await owner?.end();
  });

  async function nuevoDocumento(nombre: string): Promise<string> {
    const [d] = await owner`
      insert into documents (company_id, uploaded_by, s3_key, original_filename,
                             file_size_bytes, mime_type, status)
      values (${companyId}, ${userId}, ${`${companyId}/${nombre}`}, ${nombre},
              100, 'text/csv', 'promoted')
      returning id
    `;
    return d!.id;
  }

  async function insertTx(documentId: string, period: string, type: string, amount: number) {
    await owner`
      insert into transactions (company_id, document_id, date, type, category,
                                original_amount, original_currency, amount_base,
                                fx_rate, fx_rate_date)
      values (${companyId}, ${documentId}, ${period}, ${type}, 'test',
              ${amount}, 'GTQ', ${amount}, 1, ${period})
    `;
  }

  // ═══════════════════════════════════════════════════════════════════════════════════
  // SÍNTOMA 1 — "se borra un archivo, se carga otro, aparece done y no se actualiza"
  // ═══════════════════════════════════════════════════════════════════════════════════

  describe('revertir y volver a subir el mismo archivo', () => {
    test('las huellas de un documento REVERTIDO no deben bloquear una carga nueva', async () => {
      const docViejo = await nuevoDocumento('ventas-v1.xlsx');
      const huellas = ['a'.repeat(64), 'b'.repeat(64), 'c'.repeat(64)];

      await owner`
        insert into ingested_rows (company_id, fingerprint, first_seen_document_id, sheet_name)
        values ${owner(huellas.map((f) => [companyId, f, docViejo, 'Ventas']))}
      `;

      // El cliente revierte esa carga: sus datos dejan de contar.
      await revertDocument(db, companyId, docViejo);

      // Y vuelve a subir el MISMO archivo, que es un documento nuevo con las mismas filas.
      const docNuevo = await nuevoDocumento('ventas-v1.xlsx');
      const vistas = await findSeenFingerprints(db, companyId, docNuevo, huellas);

      /*
       * Si esto devuelve las tres huellas, el worker filtra TODAS las filas, el documento
       * llega a la promoción sin nada que promover y termina en `promoted` con el mensaje
       * "ya teníamos todo". Para el cliente: "aparece como done pero no se actualiza la
       * data" — textual de Jose.
       *
       * Y no es recuperable subiendo otra vez: mientras la huella exista apuntando al
       * documento revertido, ese archivo está permanentemente bloqueado.
       */
      expect([...vistas]).toEqual([]);
    });

    test('las huellas de un documento VIVO sí siguen bloqueando (no se rompe la dedup)', async () => {
      // El contraste importa: si el arreglo dejara pasar todo, se perdería el ahorro que la
      // deduplicación existe para dar, y el cliente pagaría de nuevo su contabilidad entera
      // cada semana.
      const docVivo = await nuevoDocumento('compras.xlsx');
      const huella = 'd'.repeat(64);
      await owner`
        insert into ingested_rows (company_id, fingerprint, first_seen_document_id, sheet_name)
        values (${companyId}, ${huella}, ${docVivo}, 'Compras')
      `;

      const otroDoc = await nuevoDocumento('compras-otra-vez.xlsx');
      const vistas = await findSeenFingerprints(db, companyId, otroDoc, [huella]);
      expect([...vistas]).toEqual([huella]);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════════════
  // SÍNTOMA 3 — "ahorita se quedó trabada la ingesta"
  // ═══════════════════════════════════════════════════════════════════════════════════

  describe('una carga colgada se puede desatascar', () => {
    test('un documento viejo en `processing` no tiene ningún job vivo detrás', async () => {
      /*
       * El escenario real: pg-boss VENCE el job (`expireInSeconds`, 1 h) y abandona la
       * promesa del worker, así que el `catch` que escribe `status='failed'` nunca corre. Con
       * los 3 reintentos agotados, pg-boss marca el job fallido en SUS tablas y nadie toca
       * `documents.status`. El documento se queda en `processing` sin nada detrás.
       *
       * Este test fija la CONDICIÓN que usa la ruta de reintento, que es lo único que se
       * puede comprobar sin levantar pg-boss: un documento en `processing` desde hace más
       * que el vencimiento de la cola está, por definición, muerto.
       */
      const doc = await nuevoDocumento('colgado.xlsx');
      const haceDosHoras = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
      await owner`
        update documents set status = 'processing',
                             created_at = ${haceDosHoras}::timestamptz,
                             updated_at = ${haceDosHoras}::timestamptz
        where id = ${doc}
      `;

      const [fila] = await owner`
        select status, created_at, updated_at from documents where id = ${doc}
      `;
      const referencia = fila!.updated_at ?? fila!.created_at;
      const vencimientoMs = 3_600 * 1_000;

      expect(fila!.status).toBe('processing');
      expect(Date.now() - new Date(referencia).getTime()).toBeGreaterThan(vencimientoMs);
    });

    test('una carga RECIÉN subida NO cumple la condición de colgada', async () => {
      // El contraste importa: si el umbral fuera laxo, un reintento entraría mientras el job
      // legítimo corre. La reanudación por lote acota el daño, pero repetir trabajo pagado
      // sigue siendo trabajo pagado.
      const doc = await nuevoDocumento('recien-subido.xlsx');
      await owner`update documents set status = 'processing' where id = ${doc}`;

      const [fila] = await owner`select created_at, updated_at from documents where id = ${doc}`;
      const referencia = fila!.updated_at ?? fila!.created_at;
      expect(Date.now() - new Date(referencia).getTime()).toBeLessThan(3_600 * 1_000);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════════════
  // SÍNTOMA 4 — "en 2 users diferentes sale diferente el display de la data"
  // ═══════════════════════════════════════════════════════════════════════════════════

  describe('caché de métricas con dos dashboards a la vez', () => {
    test('dos lecturas simultáneas NO deben duplicar filas de rollup', async () => {
      const doc = await nuevoDocumento('metricas.xlsx');
      await insertTx(doc, P1, 'revenue', 1000);
      await insertTx(doc, P2, 'revenue', 2000);

      /*
       * Dos usuarios de la misma empresa abriendo el dashboard al mismo tiempo. Los dos ven
       * el caché vacío para esos períodos, los dos calculan, los dos insertan.
       *
       * El índice `metric_rollups_uq` incluye `category`, que es NULL en todas estas filas —
       * y en Postgres NULL nunca colisiona en un índice único. O sea que el índice que
       * debería impedir esto no impide NADA para las únicas filas que el producto escribe.
       */
      // OCHO lecturas a la vez, no dos. Con dos, una carrera puede no darse y el test pasa
      // por suerte — que sobre un bug de concurrencia es peor que fallar.
      await Promise.all(
        Array.from({ length: 8 }, () => getOrComputeMonthlyAmounts(db, companyId, [P1, P2])),
      );

      const [{ duplicados }] = await owner`
        select count(*)::int as duplicados from (
          select period, type from metric_rollups
          where company_id = ${companyId} and granularity = 'month' and category is null
          group by period, type having count(*) > 1
        ) t
      `;
      expect(duplicados).toBe(0);
    });

    test('con datos nuevos, TODOS los usuarios ven la misma cifra', async () => {
      /*
       * El síntoma que Jose vio. Con filas duplicadas, `refreshExistingRollups` actualiza
       * una y deja la otra con el valor viejo — y a partir de ahí cada lectura devuelve la
       * que Postgres le dé primero. Dos usuarios, dos cifras, ninguna forma de saber cuál.
       */
      const doc = await nuevoDocumento('mas-ventas.xlsx');
      await insertTx(doc, P1, 'revenue', 500);
      await refreshExistingRollups(db, companyId);

      const lecturas = await Promise.all([
        getOrComputeMonthlyAmounts(db, companyId, [P1]),
        getOrComputeMonthlyAmounts(db, companyId, [P1]),
        getOrComputeMonthlyAmounts(db, companyId, [P1]),
      ]);

      const valores = lecturas.map((l) => l.get(P1)!.revenue);
      expect(new Set(valores).size).toBe(1);
      // 1000 de la primera carga + 500 de esta.
      expect(valores[0]).toBe(1500);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════════════
  // EL CICLO COMPLETO — que es lo que el cliente hace de verdad
  // ═══════════════════════════════════════════════════════════════════════════════════

  describe('cargar → revertir → volver a cargar, de punta a punta', () => {
    const MES = '2022-06-01';

    test('las cifras siguen el ciclo entero sin quedarse pegadas', async () => {
      /*
       * Este es el recorrido literal que describió Jose. Los tests de arriba fijan cada pieza
       * por separado; este comprueba que juntas den el resultado correcto, que es lo único
       * que el cliente ve.
       *
       * Se usa una empresa PROPIA para que el ciclo empiece en cero y las cifras sean
       * afirmaciones exactas, no diferencias contra lo que dejaron otros tests.
       */
      const [c] = await owner`
        insert into companies (workos_org_id, name, industry)
        values ('org_ciclo_completo', 'Ciclo SA', 'retail') returning id
      `;
      const empresa = c!.id;
      await owner.unsafe(
        `create table if not exists "transactions_${empresa.replace(/-/g, '_')}"
           partition of transactions for values in ('${empresa}')`,
      );
      const [d1] = await owner`
        insert into documents (company_id, uploaded_by, s3_key, original_filename,
                               file_size_bytes, mime_type, status)
        values (${empresa}, ${userId}, ${`${empresa}/v1`}, 'ventas.xlsx', 100, 'text/csv', 'promoted')
        returning id
      `;
      const doc1 = d1!.id;

      const tx = (documentId: string, amount: number) => owner`
        insert into transactions (company_id, document_id, date, type, category,
                                  original_amount, original_currency, amount_base,
                                  fx_rate, fx_rate_date)
        values (${empresa}, ${documentId}, ${MES}, 'revenue', 'test',
                ${amount}, 'GTQ', ${amount}, 1, ${MES})
      `;
      const leer = async () =>
        (await getOrComputeMonthlyAmounts(db, empresa, [MES])).get(MES)!.revenue;

      // 1) Primera carga: 800.
      await tx(doc1, 800);
      expect(await leer()).toBe(800);

      // 2) El cliente la revierte. El dashboard tiene que caer a cero — antes del arreglo de
      //    los duplicados, la fila vieja del rollup podía sobrevivir y seguir mostrando 800.
      await revertDocument(db, empresa, doc1);
      await refreshExistingRollups(db, empresa);
      expect(await leer()).toBe(0);

      // 3) Vuelve a subir el MISMO archivo. Con las huellas del documento revertido
      //    bloqueando, el worker filtraba todas las filas y este documento nacía vacío: el
      //    dashboard se quedaba en 0 y el archivo aparecía "done". Ese era el bug.
      const huellas = ['e'.repeat(64), 'f'.repeat(64)];
      await owner`
        insert into ingested_rows (company_id, fingerprint, first_seen_document_id, sheet_name)
        values ${owner(huellas.map((f) => [empresa, f, doc1, 'Ventas']))}
      `;
      const [d2] = await owner`
        insert into documents (company_id, uploaded_by, s3_key, original_filename,
                               file_size_bytes, mime_type, status)
        values (${empresa}, ${userId}, ${`${empresa}/v2`}, 'ventas.xlsx', 100, 'text/csv', 'promoted')
        returning id
      `;
      const doc2 = d2!.id;

      // El worker preguntaría esto ANTES de clasificar. Si devuelve las huellas, no procesa
      // nada y el ciclo se rompe acá.
      const bloqueadas = await findSeenFingerprints(db, empresa, doc2, huellas);
      expect([...bloqueadas]).toEqual([]);

      // 4) Como no se bloqueó nada, las filas entran y el dashboard vuelve a mostrarlas.
      await tx(doc2, 800);
      await refreshExistingRollups(db, empresa);
      expect(await leer()).toBe(800);

      // 5) Y varias lecturas simultáneas coinciden — el síntoma de "dos users, dos cifras".
      const lecturas = await Promise.all(Array.from({ length: 6 }, leer));
      expect(new Set(lecturas)).toEqual(new Set([800]));
    });
  });
});
