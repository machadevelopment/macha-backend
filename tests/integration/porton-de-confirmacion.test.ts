import { describe, expect, test, beforeAll, afterAll, mock } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { Elysia } from 'elysia';
import { setupTestDatabase, ownerConnection, testOwnerUrl, testAppUrl } from './setup';
import { crearDobleDeCola } from './doble-de-cola';

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * EL PORTÓN: NADA ENTRA AL DASHBOARD SIN QUE EL DUEÑO LO CONFIRME (migración 0042)
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *
 * Decisión de Keneth con la medición delante. El motivo no es desconfiar del modelo: los siete
 * fallos de ingesta de esta semana NO fueron filas dudosas, fueron decisiones sobre HOJAS
 * tomadas con alta confianza y equivocadas — una cartera de clientes leída como ingresos
 * (Q 13.362), un consolidado propio contado dos veces (+945), un presupuesto entrando como
 * dinero real. Ninguna la habría atrapado una revisión por fila; todas se ven de un vistazo en
 * un resumen por hoja con su monto al lado.
 *
 * ⚠️ REINTRODUCE LA FORMA QUE DEJÓ 0 FILAS EN PRODUCCIÓN antes de la migración 0020, y se
 * asumió a propósito. Lo que este archivo tiene que garantizar es que el portón se ABRA: si
 * confirmar no publica, el cliente se queda sin su contabilidad y sin saber por qué.
 */
/*
 * El "token" es el `workos_user_id`. `mock.module` es GLOBAL al proceso, así que este doble lo
 * declara cada archivo que monta el módulo con guards: confiar en que otro lo haya cargado
 * primero hace que el resultado dependa del orden de archivos, que es el modo de fallo que
 * este repo ya documentó (verde en local, rojo en CI).
 */
mock.module('@/lib/auth', () => ({
  verifyToken: async (token: string) => ({ sub: token }),
}));

/*
 * La app corre contra la MISMA base efímera que los fixtures: sin esto el guard resuelve la
 * identidad contra otra conexión y devuelve "No Macha account for this identity" — un 403 que
 * parece de permisos y es de configuración.
 */
process.env.DATABASE_URL = testOwnerUrl;
process.env.APP_DATABASE_URL = testAppUrl;
process.env.WORKOS_JWKS_URL = 'https://example.invalid/jwks';

const dobleDeCola = crearDobleDeCola();
const encolados = dobleDeCola.encolados;
mock.module('@/queue', () => dobleDeCola.modulo);

const { ingestion } = await import('@/modules/ingestion');
const { promoteDocument } = await import('@/lib/promotion');
const { drizzle } = await import('drizzle-orm/postgres-js');
const schema = await import('@/db/schema');

const app = new Elysia().use(ingestion);
const SUF = randomUUID().slice(0, 8);
const WOS = `wos_porton_${SUF}`;

const pedir = (path: string, init?: RequestInit) =>
  app.handle(
    new Request(`http://localhost/documents${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${WOS}`,
        'content-type': 'application/json',
        ...(init?.headers ?? {}),
      },
    }),
  );

const owner = ownerConnection();
let companyId: string;
let userId: string;
let documentId: string;

beforeAll(async () => {
  await setupTestDatabase();

  const [c] = await owner`
    insert into companies (workos_org_id, name, industry, base_currency)
    values (${`org_porton_${SUF}`}, ${`Porton ${SUF}`}, 'retail', 'GTQ') returning id`;
  companyId = c!.id;

  const [u] = await owner`
    insert into users (workos_user_id, email)
    values (${WOS}, ${`porton-${SUF}@test.local`}) returning id`;
  userId = u!.id;

  await owner`insert into company_users (company_id, user_id, role)
              values (${companyId}, ${userId}, 'owner')`;

  await owner.unsafe(
    `create table if not exists "transactions_${companyId.replace(/-/g, '_')}"
     partition of transactions for values in ('${companyId}')`,
  );

  const [d] = await owner`
    insert into documents (company_id, uploaded_by, s3_key, original_filename,
                           file_size_bytes, mime_type, status, row_count, flagged_count)
    values (${companyId}, ${userId}, ${`${companyId}/p.xlsx`}, 'p.xlsx', 100, 'text/csv',
            'awaiting_confirmation', 3, 0)
    returning id`;
  documentId = d!.id;

  // Tres ventas limpias, listas para publicarse: `clean` y sin promover.
  for (const [i, monto] of [1000, 2000, 3000].entries()) {
    await owner`
      insert into staging_rows (company_id, document_id, target_entity, payload, confidence,
                                flag_reason, review_status, sheet_name)
      values (${companyId}, ${documentId}, 'transaction', ${owner.json({
        type: 'revenue',
        category: 'ventas',
        date: `2026-0${i + 1}-15`,
        description: `Venta ${i + 1}`,
        originalAmount: monto,
        originalCurrency: 'GTQ',
      })}, 0.95, null, 'clean', 'Ventas')`;
  }
});

afterAll(async () => {
  await owner?.end();
});

const enElLedger = async (): Promise<number> => {
  const [r] = await owner`
    select coalesce(sum(amount_base), 0)::float as total from transactions
    where company_id = ${companyId} and deleted_at is null`;
  return Number(r!.total);
};

describe('sin confirmar, nada entra', () => {
  test('la promoción se niega y el ledger sigue vacío', async () => {
    const db = drizzle(owner, { schema }) as never;
    const r = await promoteDocument(db, companyId, documentId);
    /*
     * `promoteDocument` NO es el portón —su contrato es "inserta lo promovible" y lo usan el
     * staff y la propia confirmación—, así que acá SÍ promueve. El portón vive en sus dos
     * llamadores: el worker y `encolarPromocionDeLoResuelto`. Lo que este test fija es que la
     * vía por la que el cliente llega esté cerrada, y eso se comprueba abajo.
     */
    expect(r.promoted).toBe(true);
    // Se deshace para probar el camino real.
    await owner`update transactions set deleted_at = now() where company_id = ${companyId}`;
    await owner`update staging_rows set promoted_at = null where document_id = ${documentId}`;
  });

  test('⚠️ la vía del cliente NO encola la promoción mientras no haya confirmado', async () => {
    encolados.length = 0;
    const { encolarPromocionDeLoResuelto } = await import('@/lib/promotion');
    const db = drizzle(owner, { schema }) as never;
    await encolarPromocionDeLoResuelto(db, companyId, documentId);
    // Si esto encolara, el portón sería decorativo: la carga se publicaría sola igual.
    expect(encolados.filter((e) => e.queue === 'document.promote')).toHaveLength(0);
  });

  test('el GET dice qué entendimos, y que todavía no está confirmado', async () => {
    const r = await pedir(`/${documentId}/confirmacion`);
    expect(r.status).toBe(200);
    /*
     * Lo que hace de portón es `confirmedAt`, no el estado: una carga puede estar `promoted`
     * por una pasada anterior y aun así tener filas nuevas sin confirmar. La condición que
     * `promoteDocument` y `encolarPromocionDeLoResuelto` preguntan es esta.
     */
    const b = (await r.json()) as { confirmedAt: string | null };
    expect(b.confirmedAt).toBeNull();
  });
});

describe('confirmar publica', () => {
  test('EL PORTÓN SE ABRE: confirmar encola la promoción', async () => {
    encolados.length = 0;
    const r = await pedir(`/${documentId}/confirmar`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
    expect(r.status).toBe(200);
    const b = (await r.json()) as { confirmado: boolean; yaEstaba: boolean };
    expect(b.confirmado).toBe(true);
    expect(b.yaEstaba).toBe(false);

    /*
     * La aserción que hace que el portón no sea una trampa. Si confirmar no publica, el
     * cliente se queda sin su contabilidad y sin saber por qué — que es exactamente el
     * desenlace que dejó 0 filas en producción antes de la 0020.
     */
    expect(encolados.filter((e) => e.queue === 'document.promote')).toHaveLength(1);

    const db = drizzle(owner, { schema }) as never;
    const p = await promoteDocument(db, companyId, documentId);
    expect(p.promoted).toBe(true);
    expect(await enElLedger()).toBeCloseTo(6000, 2);
  });

  test('confirmar dos veces es idempotente y lo dice', async () => {
    // El cliente puede apretar dos veces, o volver por el enlace del correo.
    const r = await pedir(`/${documentId}/confirmar`, { method: 'POST', body: JSON.stringify({}) });
    const b = (await r.json()) as { yaEstaba: boolean };
    expect(b.yaEstaba).toBe(true);
  });
});

describe('el cliente puede EXCLUIR una hoja que no debería contarse', () => {
  let doc2: string;

  test('preparar una carga con dos hojas', async () => {
    const [d] = await owner`
      insert into documents (company_id, uploaded_by, s3_key, original_filename,
                             file_size_bytes, mime_type, status, row_count, flagged_count)
      values (${companyId}, ${userId}, ${`${companyId}/q.xlsx`}, 'q.xlsx', 100, 'text/csv',
              'awaiting_confirmation', 2, 0) returning id`;
    doc2 = d!.id;
    for (const hoja of ['Ventas', 'Resumen']) {
      const payload = {
        type: 'revenue',
        category: 'ventas',
        date: '2026-05-10',
        description: hoja,
        originalAmount: 5000,
        originalCurrency: 'GTQ',
      };
      await owner`
        insert into staging_rows (company_id, document_id, target_entity, payload, confidence,
                                  flag_reason, review_status, sheet_name)
        values (${companyId}, ${doc2}, 'transaction', ${JSON.stringify(payload)}::jsonb,
                0.95, null, 'clean', ${hoja})`;
    }
  });

  test('la hoja excluida se RECHAZA y no entra; la otra sí', async () => {
    const r = await pedir(`/${doc2}/confirmar`, {
      method: 'POST',
      body: JSON.stringify({ excluir: ['Resumen'] }),
    });
    expect(r.status).toBe(200);
    expect(((await r.json()) as { hojasExcluidas: number }).hojasExcluidas).toBe(1);

    const db = drizzle(owner, { schema }) as never;
    await promoteDocument(db, companyId, doc2);

    // 6000 de la carga anterior + 5000 de `Ventas`. El `Resumen` que el dueño desconoció NO.
    expect(await enElLedger()).toBeCloseTo(11_000, 2);

    /*
     * Y queda el RASTRO: `rejected`, no borrada. Qué decidió el dueño sobre su propio archivo
     * tiene que poder leerse después — es la misma razón por la que staff rechaza en vez de
     * borrar.
     */
    const [rechazada] = await owner`
      select review_status, reviewed_by from staging_rows
      where document_id = ${doc2} and sheet_name = 'Resumen'`;
    expect(rechazada!.review_status).toBe('rejected');
    expect(rechazada!.reviewed_by).toBe(userId);
  });
});

describe('el cliente corrige la NATURALEZA de una hoja entera', () => {
  /*
   * Excluir resuelve "esto no debería contar". Lo que faltaba es "esto SÍ cuenta, pero no es lo
   * que ustedes creen" — el caso donde el modelo leyó bien la forma de la hoja y mal su
   * naturaleza. Va por HOJA porque una hoja es homogénea: quien escribe `Servicios_Varios` no
   * mete ventas ahí, y preguntar concepto por concepto lo que el dueño dice de un golpe
   * convierte una decisión en un formulario.
   */
  let doc4: string;

  test('preparar: una hoja con dos ventas y el costo derivado de una', async () => {
    const [d] = await owner`
      insert into documents (company_id, uploaded_by, s3_key, original_filename,
                             file_size_bytes, mime_type, status, row_count, flagged_count)
      values (${companyId}, ${userId}, ${`${companyId}/r.xlsx`}, 'r.xlsx', 100, 'text/csv',
              'awaiting_confirmation', 3, 0) returning id`;
    doc4 = d!.id;

    const filas = [
      { type: 'revenue', category: 'ventas', originalAmount: 1000 },
      { type: 'revenue', category: 'ventas', originalAmount: 2000 },
      // Derivada: su tipo lo puso una regla contable, no la naturaleza de la hoja.
      {
        type: 'cogs',
        category: 'costo_de_ventas',
        originalAmount: 600,
        derivadaDelPipeline: true,
      },
    ];
    for (const f of filas) {
      await owner`
        insert into staging_rows (company_id, document_id, target_entity, payload, confidence,
                                  flag_reason, review_status, sheet_name)
        values (${companyId}, ${doc4}, 'transaction',
                ${JSON.stringify({ ...f, date: '2026-05-10', description: 'Fila', originalCurrency: 'GTQ' })}::jsonb,
                0.95, null, 'clean', 'Servicios')`;
    }
  });

  test('"esto no son ingresos, son gastos" cambia la hoja entera de un golpe', async () => {
    const r = await pedir(`/${doc4}/confirmar`, {
      method: 'POST',
      body: JSON.stringify({
        reclasificar: [{ hoja: 'Servicios', type: 'opex', category: 'servicios' }],
      }),
    });
    expect(r.status).toBe(200);
    expect(((await r.json()) as { hojasReclasificadas: number }).hojasReclasificadas).toBe(1);

    const filas = await owner`
      select payload->>'type' as tipo, (payload->>'originalAmount')::numeric as monto
      from staging_rows where document_id = ${doc4} order by monto desc`;

    // Las dos ventas pasan a gasto: es lo que el dueño dijo de SU hoja.
    expect(filas[0]!.tipo).toBe('opex');
    expect(filas[1]!.tipo).toBe('opex');

    /*
     * ⚠️ Y el costo derivado NO. Reclasificar la hoja no puede convertir en gasto el costo que
     * una regla contable derivó de su venta — es el mismo fallo que se midió con el concepto
     * "Aceite 1 L" (+1.160 de ingreso, −1.160 de costo), a escala de hoja.
     */
    expect(filas[2]!.tipo).toBe('cogs');
  });
});
