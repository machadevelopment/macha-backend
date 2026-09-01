import { describe, expect, test, beforeAll, afterAll, mock } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/postgres-js';
import { setupTestDatabase, ownerConnection } from './setup';
import { crearDobleDeCola } from './doble-de-cola';
import * as schema from '@/db/schema';
import type { DB } from '@/db/client';

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * EL CORREO DE "TU ARCHIVO NECESITA TU ATENCIÓN" (CU-868kyur58)
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *
 * Se prueba contra Postgres real y no con dobles porque las tres reglas que importan viven en
 * consultas, no en lógica de JavaScript: qué cargas siguen esperando al cliente, cuáles ya se
 * avisaron, y cuántos CONCEPTOS distintos hay en `staging_rows`.
 *
 * ═══ LO QUE PUEDE SALIR MAL, Y NINGUNA HACE RUIDO ═══
 *
 *  1. **Avisar por filas que el cliente no puede contestar.** Una carga marcada solo por
 *     `invalid_date` produce CERO preguntas: el correo lo llevaría a una pantalla vacía y le
 *     enseñaría a ignorar el próximo aviso, que sí va a importar.
 *  2. **Un correo por archivo.** En el onboarding se suben tres o cuatro casi a la vez.
 *  3. **El mismo correo dos veces**, si el worker se reintenta.
 *  4. **Perder el caso más común.** Con promoción parcial, una carga con filas retenidas queda
 *     en `promoted` y no en `review`. Un disparador que solo mire `review` no avisa nunca de la
 *     carga normal.
 */

/*
 * La cola no corre acá: lo que se comprueba es que se ENCOLE el correo con el contenido
 * correcto, no que Resend lo entregue.
 *
 * El doble es el COMPARTIDO y no uno local: `mock.module` es global al proceso y la suite corre
 * en una sola invocación, así que dos dobles distintos hacen que gane el último en cargarse.
 * Hay un test que lo vigila (`doble-de-cola.test.ts`) y me lo puso en rojo al escribir esto.
 */
const dobleDeCola = crearDobleDeCola();
const encolados = dobleDeCola.encolados;
mock.module('@/queue', () => dobleDeCola.modulo);

const { avisarConceptosPendientes } = await import('@/lib/aviso-de-revision');

const owner = ownerConnection();
let db: DB;
let companyId: string;
let userId: string;

const SUFIJO = randomUUID().slice(0, 8);

beforeAll(async () => {
  await setupTestDatabase();
  db = drizzle(owner, { schema }) as unknown as DB;

  const [c] = await owner`
    insert into companies (workos_org_id, name, industry, base_currency, locale)
    values (${`org_aviso_${SUFIJO}`}, ${`Aviso ${SUFIJO}`}, 'retail', 'GTQ', 'es')
    returning id`;
  companyId = c!.id;

  const [u] = await owner`
    insert into users (workos_user_id, email)
    values (${`wos_aviso_${SUFIJO}`}, ${`duena-${SUFIJO}@test.local`}) returning id`;
  userId = u!.id;

  await owner`
    insert into company_users (company_id, user_id, role, status, receives_reports)
    values (${companyId}, ${userId}, 'owner', 'active', true)`;
});

afterAll(async () => {
  await owner?.end();
});

/** Una carga en el estado en que la deja la ingesta, con las filas marcadas que se le pidan. */
async function cargaConConceptos(
  nombre: string,
  filas: { concepto: string; flag: string }[],
  status: 'review' | 'promoted' = 'review',
): Promise<string> {
  const [d] = await owner`
    insert into documents (company_id, uploaded_by, s3_key, original_filename,
                           file_size_bytes, mime_type, status, row_count, flagged_count)
    values (${companyId}, ${userId}, ${`${companyId}/${randomUUID()}`}, ${nombre},
            100, 'text/csv', ${status}, 100, ${filas.length})
    returning id`;
  const documentId = d!.id as string;

  for (const f of filas) {
    await owner`
      insert into staging_rows (company_id, document_id, target_entity, payload, confidence,
                                flag_reason, review_status)
      values (${companyId}, ${documentId}, 'transaction',
              ${JSON.stringify({
                type: 'opex',
                category: null,
                date: '2026-07-15',
                originalAmount: 1500,
                originalCurrency: 'GTQ',
                description: f.concepto,
              })}::jsonb, 0.35, ${f.flag}, 'pending')`;
  }
  return documentId;
}

/** Solo los correos: el worker encola otras cosas y contarlas todas haría frágil el test. */
const correos = () => encolados.filter((e) => e.queue === 'email.send');
const ultimoCorreo = () => correos().at(-1)?.payload as Record<string, unknown> | undefined;

describe('el aviso proactivo de conceptos pendientes', () => {
  test('1) una carga con conceptos contestables dispara UN correo, con el conteo de CONCEPTOS', async () => {
    /*
     * Cinco filas marcadas pero solo DOS conceptos distintos. El correo tiene que decir 2:
     * es lo que el cliente va a ver al entrar, y prometer 5 destruye el aviso la primera vez
     * que abre la pantalla.
     */
    const doc = await cargaConConceptos('Ventas_Agosto.xlsx', [
      { concepto: 'Pago a CLARO', flag: 'low_confidence:0.35' },
      { concepto: 'pago claro', flag: 'low_confidence:0.40' },
      { concepto: 'Pago a Claro', flag: 'missing_category' },
      { concepto: 'Flete Cropa', flag: 'missing_category' },
      { concepto: 'Flete Cropa', flag: 'low_confidence:0.31' },
    ]);

    const r = await avisarConceptosPendientes(db, companyId, doc);

    expect(r.enviado).toBe(true);
    expect(r.conceptos).toBe(2);
    expect(r.documentos).toEqual([doc]);

    const correo = ultimoCorreo()!;
    expect(correo.kind).toBe('review_needed');
    // `refId` es el DOCUMENTO: es lo que hace de marca de idempotencia.
    expect(correo.refId).toBe(doc);
    expect(correo.subject).toContain('Ventas_Agosto.xlsx');
    expect(String(correo.html)).toContain('2 conceptos');
    // El CTA lleva al documento exacto, no a la sección.
    expect(String(correo.html)).toContain(`/upload?doc=${doc}`);
  });

  test('2) no se repite: el mismo documento no vuelve a disparar correo', async () => {
    const antes = correos().length;
    const doc = (
      await owner`select ref_id from notifications
                  where company_id = ${companyId} and kind = 'review_needed' limit 1`
    )[0]!.ref_id as string;

    const r = await avisarConceptosPendientes(db, companyId, doc);

    expect(r.enviado).toBe(false);
    expect(r.motivo).toBe('ya_avisado');
    expect(correos().length).toBe(antes);
  });

  test('3) una carga marcada SOLO por problemas de dato no manda correo', async () => {
    /*
     * `invalid_date` / `invalid_amount` no los arregla ninguna categoría. El ticket pedía
     * disparar por `flaggedCount > 0`; tomado literal, este caso mandaría un correo que
     * promete preguntas y aterriza en una pantalla vacía.
     */
    const antes = correos().length;
    const doc = await cargaConConceptos('SoloFechasMalas.xlsx', [
      { concepto: 'Compra de vitrinas', flag: 'invalid_date' },
      { concepto: 'Otra compra', flag: 'invalid_amount' },
    ]);

    const r = await avisarConceptosPendientes(db, companyId, doc);

    expect(r.enviado).toBe(false);
    expect(r.motivo).toBe('sin_conceptos');
    expect(correos().length).toBe(antes);
  });

  test('4) dos cargas a la vez: UN correo que menciona las dos, y marca las dos', async () => {
    const antes = correos().length;
    const a = await cargaConConceptos('Compras_Julio.xlsx', [
      { concepto: 'Cropa', flag: 'missing_category' },
    ]);
    const b = await cargaConConceptos('Gastos_Julio.xlsx', [
      { concepto: 'Vecinos SA', flag: 'missing_category' },
    ]);

    // Termina la segunda (la primera todavía no se avisó): el correo consolida las dos.
    const r = await avisarConceptosPendientes(db, companyId, b);

    expect(r.enviado).toBe(true);
    expect(r.documentos.sort()).toEqual([a, b].sort());
    expect(r.conceptos).toBe(2);
    // UN solo correo por destinatario, no uno por archivo.
    expect(correos().length - antes).toBe(1);
    const html = String(ultimoCorreo()!.html);
    expect(html).toContain('Compras_Julio.xlsx');
    expect(html).toContain('Gastos_Julio.xlsx');

    // Y las DOS quedan marcadas, así que la primera ya no puede disparar su propio correo.
    const seg = await avisarConceptosPendientes(db, companyId, a);
    expect(seg.enviado).toBe(false);
    expect(seg.motivo).toBe('ya_avisado');
  });

  test('5) el caso NORMAL de la promoción parcial: `promoted` con filas marcadas SÍ avisa', async () => {
    /*
     * Es el que el ticket se perdía. Desde la migración 0020 una carga con filas retenidas
     * termina en `promoted` con `flagged_count > 0` — el estado normal — y solo llega a
     * `review` la que no pudo promover nada. Un disparador que mirara únicamente `review`
     * nunca habría avisado del caso común.
     */
    const antes = correos().length;
    const doc = await cargaConConceptos(
      'Parcial.xlsx',
      [{ concepto: 'Servicio raro', flag: 'low_confidence:0.5' }],
      'promoted',
    );

    const r = await avisarConceptosPendientes(db, companyId, doc);

    expect(r.enviado).toBe(true);
    expect(correos().length - antes).toBe(1);
  });

  test('6) una carga LIMPIA no reabre el aviso de las que ya se avisaron', async () => {
    /*
     * Sin esta guarda, cada archivo nuevo mandaría un recordatorio de lo viejo pendiente:
     * la definición de correo que se aprende a ignorar. El disparo lo causa siempre una carga
     * NUEVA con conceptos propios.
     */
    const antes = correos().length;
    const [d] = await owner`
      insert into documents (company_id, uploaded_by, s3_key, original_filename,
                             file_size_bytes, mime_type, status, row_count, flagged_count)
      values (${companyId}, ${userId}, ${`${companyId}/${randomUUID()}`}, 'Limpia.xlsx',
              100, 'text/csv', 'promoted', 50, 0)
      returning id`;

    const r = await avisarConceptosPendientes(db, companyId, d!.id as string);

    expect(r.enviado).toBe(false);
    expect(correos().length).toBe(antes);
  });

  test('7) el registro de idempotencia es una fila real de `notifications`', async () => {
    // No hay columna nueva: la tabla que ya existe ES el registro, y encima es la que el
    // equipo puede mirar para saber qué se le mandó a un cliente.
    const filas = await owner`
      select kind, status from notifications
      where company_id = ${companyId} and kind = 'review_needed'`;
    expect(filas.length).toBeGreaterThanOrEqual(4);
    expect(filas.every((f) => f.status === 'queued')).toBe(true);
  });
});
