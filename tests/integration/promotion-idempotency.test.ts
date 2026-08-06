import { describe, expect, test, beforeAll, afterAll } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/postgres-js';
import { setupTestDatabase, ownerConnection } from './setup';
import * as schema from '@/db/schema';
import { provisionTenantPartitions } from '@/lib/tenant-provisioning';
import { promoteDocument } from '@/lib/promotion';

/**
 * La promoción no puede insertar dos veces el mismo documento.
 *
 * EL CASO REAL (producción, 2026-08-06, documento `ce2a824b`). pg-boss venció el job de
 * ingesta a los 15 minutos y encoló un segundo intento **mientras el primero seguía
 * corriendo** — vencer es una marca en su tabla, no una cancelación. Los lotes ya estaban
 * protegidos por el índice único de `document_ingest_batches`, pero la promoción no tenía
 * nada: las dos ejecuciones habrían insertado el MISMO `staging_rows` completo. En un
 * producto financiero eso es duplicar los ingresos y los costos del cliente, en silencio y
 * sin nada en pantalla que lo delate.
 *
 * Se prueba contra Postgres real porque la garantía ES de Postgres: la reserva es un
 * `UPDATE ... WHERE status <> 'promoted'` que toma el lock de la fila, y es ese lock el
 * que serializa dos promociones simultáneas. Un mock del `db` pasaría en verde con la
 * carrera abierta de par en par.
 */
describe('idempotencia de la promoción', () => {
  let owner: ReturnType<typeof ownerConnection>;
  let db: ReturnType<typeof drizzle<typeof schema>>;
  const empresa = randomUUID();

  beforeAll(async () => {
    await setupTestDatabase();
    owner = ownerConnection();
    db = drizzle(owner, { schema });
    await owner`
      insert into companies (id, workos_org_id, name, industry, base_currency, locale)
      values (${empresa}, ${'org_' + empresa}, ${'Promo ' + empresa}, 'retail', 'GTQ', 'es')
    `;
    await provisionTenantPartitions(empresa);
  });

  afterAll(async () => {
    await owner?.end();
  });

  /** Documento con `n` filas de staging ya aprobadas, listo para promover. */
  async function documentoListo(n: number): Promise<string> {
    const documento = randomUUID();
    await owner`
      insert into documents (
        id, company_id, uploaded_by, s3_key, original_filename,
        file_size_bytes, mime_type, status
      ) values (
        ${documento}, ${empresa}, ${randomUUID()}, ${empresa + '/' + documento}, 'libro.xlsx',
        1024, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'processing'
      )
    `;
    for (let i = 0; i < n; i++) {
      await owner`
        insert into staging_rows (company_id, document_id, target_entity, confidence, payload, review_status)
        values (
          ${empresa}, ${documento}, 'transaction', 0.95,
          ${JSON.stringify({
            type: 'revenue',
            category: 'ventas',
            date: '2026-03-10',
            originalAmount: 100,
            originalCurrency: 'GTQ',
          })}::jsonb,
          'approved'
        )
      `;
    }
    return documento;
  }

  const cuantasTransacciones = async (documento: string): Promise<number> => {
    const [fila] = await owner`
      select count(*)::int n from transactions where document_id = ${documento}`;
    return fila!.n as number;
  };

  test('la primera promoción inserta; la segunda no vuelve a insertar', async () => {
    const documento = await documentoListo(3);

    const primera = await promoteDocument(db, empresa, documento);
    expect(primera.promoted).toBe(true);
    expect(await cuantasTransacciones(documento)).toBe(3);

    // Sin la reserva, esta llamada volvía a leer las MISMAS `staging_rows` y las insertaba
    // otra vez: 6 transacciones para 3 filas reales.
    const segunda = await promoteDocument(db, empresa, documento);
    expect(segunda.promoted).toBe(false);
    expect(segunda).toMatchObject({ reason: 'already_promoted' });
    expect(await cuantasTransacciones(documento)).toBe(3);
  });

  test('un documento sin filas no queda marcado como promovido por la reserva', async () => {
    // La reserva marca `promoted` ANTES de saber si hay algo que promover. Si no se
    // liberara, un archivo ilegible terminaría diciéndole al cliente que se procesó bien.
    const documento = await documentoListo(0);

    const resultado = await promoteDocument(db, empresa, documento);
    expect(resultado).toMatchObject({ promoted: false, reason: 'no_rows' });

    const [doc] = await owner`select status, promoted_at from documents where id = ${documento}`;
    expect(doc!.status).not.toBe('promoted');
    expect(doc!.promoted_at).toBeNull();
  });

  test('un documento con filas pendientes tampoco queda marcado como promovido', async () => {
    const documento = await documentoListo(2);
    await owner`
      update staging_rows set review_status = 'pending'
      where id = (select id from staging_rows where document_id = ${documento} limit 1)`;

    const resultado = await promoteDocument(db, empresa, documento);
    expect(resultado).toMatchObject({ promoted: false, reason: 'pending_rows', pendingCount: 1 });

    const [doc] = await owner`select status, promoted_at from documents where id = ${documento}`;
    expect(doc!.status).not.toBe('promoted');
    expect(doc!.promoted_at).toBeNull();
    // Y lo más importante: no insertó nada a medias.
    expect(await cuantasTransacciones(documento)).toBe(0);
  });

  /**
   * `rejected` tiene que significar algo.
   *
   * Antes, `promoteDocument` contaba `pending` Y `rejected` como bloqueantes, así que
   * rechazar una sola fila dejaba el documento entero trabado en `review` para siempre: la
   * única forma de terminar un upload era aprobar el 100% de sus filas, incluida la que
   * staff acababa de declarar mala. El estado `rejected` existía en el esquema y no tenía
   * ningún uso posible.
   *
   * Los dos tests de abajo fijan las DOS mitades del arreglo, y la segunda es la que
   * importa de verdad: dejar de contar `rejected` como bloqueante sin excluirla de la
   * inserción habría promovido a producción justo las filas marcadas como malas. El bucle
   * de inserción no miraba `review_status`.
   */
  test('una fila rechazada no bloquea la promoción', async () => {
    const documento = await documentoListo(3);
    await owner`
      update staging_rows set review_status = 'rejected'
      where id = (select id from staging_rows where document_id = ${documento} limit 1)`;

    const resultado = await promoteDocument(db, empresa, documento);
    expect(resultado.promoted).toBe(true);

    const [doc] = await owner`select status from documents where id = ${documento}`;
    expect(doc!.status).toBe('promoted');
  });

  test('la fila rechazada NO entra a producción', async () => {
    const documento = await documentoListo(3);
    await owner`
      update staging_rows set review_status = 'rejected'
      where id = (select id from staging_rows where document_id = ${documento} limit 1)`;

    await promoteDocument(db, empresa, documento);

    // 3 filas, 1 rechazada -> 2 transacciones. Con 3 acá, el rechazo no sirvió de nada.
    expect(await cuantasTransacciones(documento)).toBe(2);
  });

  test('todas rechazadas: no promueve, y se distingue de un archivo ilegible', async () => {
    const documento = await documentoListo(2);
    await owner`
      update staging_rows set review_status = 'rejected' where document_id = ${documento}`;

    const resultado = await promoteDocument(db, empresa, documento);
    // `all_rejected` y no `no_rows`: el archivo SÍ traía filas y un humano las descartó. Al
    // cliente se le dice algo distinto en cada caso.
    expect(resultado).toMatchObject({ promoted: false, reason: 'all_rejected' });
    expect(await cuantasTransacciones(documento)).toBe(0);

    const [doc] = await owner`select status, promoted_at from documents where id = ${documento}`;
    expect(doc!.status).not.toBe('promoted');
    expect(doc!.promoted_at).toBeNull();
  });

  test('la reserva es exclusiva: dos intentos SIMULTÁNEOS y solo uno gana', async () => {
    // El caso de producción tal cual, probado sobre el mecanismo que lo impide: la reserva
    // es un `UPDATE ... WHERE status <> 'promoted'`, y es el lock de fila de Postgres el
    // que serializa a los dos. El segundo espera al commit del primero, ve `promoted` y
    // afecta CERO filas — que es exactamente la señal por la que `promoteDocument` sale
    // sin insertar nada.
    //
    // Se ejercita con SQL crudo y no llamando dos veces a `promoteDocument` en paralelo
    // porque el driver de postgres.js no expone su transacción como un cliente que drizzle
    // pueda envolver. Lo que hay que demostrar es la exclusión, y esto la demuestra sin
    // rodeos; que ante `already_promoted` no se inserta nada lo cubre el primer test.
    const documento = await documentoListo(1);
    const otra = ownerConnection();
    try {
      const reservar = (conn: ReturnType<typeof ownerConnection>) =>
        conn.begin(
          (tx) => tx`
            update documents set status = 'promoted'
            where id = ${documento} and status <> 'promoted'
            returning id`,
        );

      const [a, b] = await Promise.all([reservar(owner), reservar(otra)]);

      // Exactamente uno reserva. Cuál, da igual — lo que no puede pasar es que reserven
      // los dos, porque ahí las dos ejecuciones insertarían el mismo staging_rows.
      expect((a as unknown[]).length + (b as unknown[]).length).toBe(1);
    } finally {
      await otra.end();
    }
  });
});
