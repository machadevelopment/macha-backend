import { describe, expect, test, beforeAll, afterAll, mock } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { Elysia } from 'elysia';
import { setupTestDatabase, ownerConnection, testOwnerUrl, testAppUrl } from './setup';
import { crearDobleDeCola } from './doble-de-cola';

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════
 * EL CLIENTE CONTESTA LO QUE EL SISTEMA NO ENTENDIÓ
 * ═══════════════════════════════════════════════════════════════════════════════════════
 *
 * Decisión de Semi, 2026-08-20: el concepto que quedó sin clasificar se le pregunta al
 * CLIENTE durante la subida, no a revisión interna. Es la persona que sabe qué es "Cropa" en
 * su propio libro.
 *
 * ═══ LAS CUATRO COSAS QUE PUEDEN SALIR MAL, Y NINGUNA HACE RUIDO ═══
 *
 *  1. **Que se pregunte por fila y no por concepto.** Un archivo con 400 filas marcadas y seis
 *     conceptos distintos daría 400 preguntas: revisión interna con otro nombre, en la cara
 *     del cliente. Nadie la contesta y nada falla.
 *  2. **Que contestar no cambie nada.** Si la respuesta no arregla las filas de ESTA carga, el
 *     cliente contesta, su dashboard sigue igual, y la pantalla queda como un trámite inútil.
 *  3. **Que se le pregunte algo que su respuesta no arregla.** Una fila sin fecha no la
 *     compone ninguna categoría; mostrarla le deja la impresión de que ya la resolvió.
 *  4. **Que la respuesta no se aprenda.** Volver a preguntar lo mismo la semana siguiente es
 *     exactamente lo que este mecanismo vino a evitar.
 *
 * Corre los endpoints reales contra Postgres real. Solo se falsea la firma del JWT y la cola.
 */

process.env.DATABASE_URL = testOwnerUrl;
process.env.APP_DATABASE_URL = testAppUrl;
process.env.WORKOS_JWKS_URL = 'https://example.invalid/jwks';

/** El "token" es el workos_user_id — basta para ejercitar el guard de tenant. */
mock.module('@/lib/auth', () => ({
  verifyToken: async (token: string) => ({ sub: token }),
}));

/*
 * La cola no corre acá: lo que se comprueba es que se ENCOLE la promoción, no que promueva.
 *
 * El doble es el COMPARTIDO, y este archivo es la razón por la que existe: monta el módulo de
 * ingesta completo, que importa `RETRY_POLICY`, y los cinco dobles locales que había antes no
 * lo exportaban. `mock.module` es global al proceso y el último en cargarse gana, así que el
 * síntoma fue un `SyntaxError` de importación en CI y no en local. Ver `./doble-de-cola`.
 */
const dobleDeCola = crearDobleDeCola();
const encolados = dobleDeCola.encolados;
mock.module('@/queue', () => dobleDeCola.modulo);

const { ingestion } = await import('@/modules/ingestion');
const { DiccionarioDeCategorias, claveDeConcepto } = await import('@/lib/category-dictionary');
const { drizzle } = await import('drizzle-orm/postgres-js');
const schema = await import('@/db/schema');

const app = new Elysia().use(ingestion);
const SUFIJO = randomUUID().slice(0, 8);
const WOS_USER = `wos_conceptos_${SUFIJO}`;

function pedir(path: string, init?: RequestInit) {
  return app.handle(
    new Request(`http://localhost/documents${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${WOS_USER}`,
        'content-type': 'application/json',
        ...(init?.headers ?? {}),
      },
    }),
  );
}

const owner = ownerConnection();
let companyId: string;
let userId: string;
let documentId: string;

/**
 * Las filas de staging se insertan a mano, en el estado exacto en que las deja la ingesta
 * cuando no logró clasificar: `pending`, con motivo y sin promover.
 *
 * Se arma así y no corriendo el worker a propósito: lo que este archivo prueba es el camino
 * del CLIENTE, y hacerlo depender de una corrida completa de ingesta mezclaría dos fallos
 * distintos en un mismo test rojo.
 */
const FILAS: { description: string; amount: number; flag: string; currency?: string }[] = [
  // Cinco filas del mismo concepto: la prueba de que se pregunta UNA vez, no cinco.
  ...Array.from({ length: 5 }, (_, i) => ({
    description: 'Pago a CLARO',
    amount: 1500 + i,
    flag: 'low_confidence:0.35',
  })),
  // El mismo concepto escrito distinto. Tiene que caer en el MISMO grupo.
  { description: 'pago claro', amount: 890, flag: 'low_confidence:0.40' },
  // Otro concepto, con más plata: tiene que salir PRIMERO en la lista.
  { description: 'Flete Cropa', amount: 40_000, flag: 'missing_category' },
  // Marcada por un problema de DATO: no la arregla ninguna categoría, no se pregunta.
  { description: 'Compra de vitrinas', amount: 700, flag: 'invalid_date' },
  /*
   * Una fila en USD del MISMO concepto que una en GTQ. Es lo que obliga a separar los montos
   * por moneda: sumarlas daría una cifra que no es ninguna de las dos, y un dólar contado como
   * un quetzal subestima ~7,7 veces sin que nada falle.
   */
  { description: 'Flete Cropa', amount: 200, flag: 'missing_category', currency: 'USD' },
];

beforeAll(async () => {
  await setupTestDatabase();

  const [c] = await owner`
    insert into companies (workos_org_id, name, industry, base_currency)
    values (${`wos_org_conceptos_${SUFIJO}`}, ${`Conceptos ${SUFIJO}`}, 'retail', 'GTQ')
    returning id
  `;
  companyId = c!.id;

  const [u] = await owner`
    insert into users (workos_user_id, email)
    values (${WOS_USER}, ${`conceptos-${SUFIJO}@test.local`}) returning id
  `;
  userId = u!.id;

  await owner`
    insert into company_users (company_id, user_id, role)
    values (${companyId}, ${userId}, 'owner')
  `;

  const [d] = await owner`
    insert into documents (company_id, uploaded_by, s3_key, original_filename,
                           file_size_bytes, mime_type, status, row_count, flagged_count)
    values (${companyId}, ${userId}, ${`${companyId}/gastos.xlsx`}, 'gastos.xlsx',
            100, 'text/csv', 'promoted', ${FILAS.length}, ${FILAS.length})
    returning id
  `;
  documentId = d!.id;

  for (const f of FILAS) {
    await owner`
      insert into staging_rows (company_id, document_id, target_entity, payload, confidence,
                                flag_reason, review_status)
      values (${companyId}, ${documentId}, 'transaction',
              ${owner.json({
                type: 'opex',
                category: null,
                date: '2026-07-15',
                originalAmount: f.amount,
                originalCurrency: f.currency ?? 'GTQ',
                description: f.description,
              })},
              0.35, ${f.flag}, 'pending')
    `;
  }
});

afterAll(async () => {
  await owner?.end();
});

const unNumero = async (q: Promise<{ n: number }[]>): Promise<number> => (await q)[0]!.n;

describe('GET /documents/:id/conceptos-pendientes', () => {
  test('se pregunta por CONCEPTO, no por fila', async () => {
    /*
     * Seis filas marcadas por falta de significado, escritas de dos formas, y UNA sola
     * pregunta. Es lo que hace viable la pantalla: si fueran seis, sería revisión interna con
     * otro nombre.
     */
    const r = await pedir(`/${documentId}/conceptos-pendientes`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      total: number;
      conceptos: { concepto: string; ejemplo: string; filas: number; montoTotal: number }[];
    };

    expect(body.total).toBe(2);

    const claro = body.conceptos.find((c) => c.concepto === claveDeConcepto('Pago a CLARO'));
    expect(claro).toBeDefined();
    // "Pago a CLARO" (5) + "pago claro" (1): la normalización es la MISMA que usa el
    // diccionario para guardar y buscar. Si divergiera, el cliente vería dos preguntas,
    // contestaría las dos y la segunda regla pisaría a la primera.
    expect(claro!.filas).toBe(6);
    // El ejemplo es el texto CRUDO del archivo, no la clave: el cliente reconoce lo que
    // él escribió, no `claro|pago`.
    expect(claro!.ejemplo).toBe('Pago a CLARO');
  });

  test('lo que más plata mueve va primero', async () => {
    /*
     * Si el cliente contesta una de dos y se va, que sea la que más pesa en su contabilidad.
     * `Flete Cropa` es UNA fila de Q 40.000 contra seis que suman ~Q 8.400: por cantidad de
     * filas quedaría segunda, y el orden de una lista es lo único que decide qué se contesta
     * cuando nadie la termina.
     */
    const r = await pedir(`/${documentId}/conceptos-pendientes`);
    const body = (await r.json()) as { conceptos: { concepto: string }[] };
    expect(body.conceptos[0]!.concepto).toBe(claveDeConcepto('Flete Cropa'));
  });

  test('los montos van SEPARADOS por moneda, no sumados', async () => {
    /*
     * ═══ POR QUÉ ESTO NO ES UN DETALLE DE FORMATO ═══
     *
     * Estas filas están en staging: traen `originalAmount` + `originalCurrency` y todavía no
     * tienen `amount_base`, porque la conversión ocurre al promover con la tasa snapshoteada
     * por fila. O sea que no hay una cifra convertida que sumar.
     *
     * `Flete Cropa` tiene Q 40.000 y USD 200. Sumados darían 40.200 "algo" mostrado al lado del
     * concepto como si fuera plata de verdad — un dólar contado como un quetzal, ~7,7 veces
     * subestimado, y el cliente sin forma de notarlo.
     */
    const r = await pedir(`/${documentId}/conceptos-pendientes`);
    const body = (await r.json()) as {
      conceptos: { concepto: string; montos: { currency: string; total: number }[] }[];
    };

    const cropa = body.conceptos.find((c) => c.concepto === claveDeConcepto('Flete Cropa'))!;
    expect(cropa.montos).toEqual([
      { currency: 'GTQ', total: 40_000 },
      { currency: 'USD', total: 200 },
    ]);

    // Y el que tiene una sola moneda trae una sola entrada: el caso común no se complica.
    const claro = body.conceptos.find((c) => c.concepto === claveDeConcepto('Pago a CLARO'))!;
    expect(claro.montos).toHaveLength(1);
    expect(claro.montos[0]!.currency).toBe('GTQ');
  });

  test('NO se pregunta por lo que una categoría no arregla', async () => {
    /*
     * "Compra de vitrinas" está marcada por `invalid_date`. Ninguna categoría compone una
     * fecha ilegible, así que preguntarlo sería pedirle al cliente una respuesta que no cambia
     * nada — y dejarle la impresión de que ya lo resolvió. Esa fila sigue por revisión interna.
     */
    const r = await pedir(`/${documentId}/conceptos-pendientes`);
    const body = (await r.json()) as { conceptos: { ejemplo: string }[] };
    expect(body.conceptos.map((c) => c.ejemplo)).not.toContain('Compra de vitrinas');
  });

  /**
   * ═══ EL REPORTE DE JOSE (2026-08-24) ═══
   *
   * *"hay muchas columnas que deja como flageadas, entonces es bien difícil porque da como 60
   * · resolverlos es un proceso bien manual que no debería ser tan complejo"*.
   *
   * La causa: el concepto salía SOLO de `description`, y una fila sin ella se descartaba en
   * silencio. Medido en producción sobre las 4.686 filas marcadas que una categoría arregla,
   * **1.739 no traen `description`** — y de esas, 977 traen `product` y 668 `counterparty`.
   * El concepto estaba ahí, en otra columna.
   *
   * El resultado para el cliente era el peor posible: su pantalla mostraba CERO conceptos y
   * las sesenta filas se iban enteras a revisión manual — justo el trabajo que esa pantalla
   * existe para evitar.
   */
  test('una fila SIN descripción se pregunta por su producto o su proveedor', async () => {
    const [doc] = await owner`
      insert into documents (company_id, uploaded_by, s3_key, original_filename,
                             file_size_bytes, mime_type, status, row_count, flagged_count)
      values (${companyId}, ${userId}, ${`${companyId}/ventas.xlsx`}, 'ventas.xlsx',
              100, 'text/csv', 'promoted', 3, 3)
      returning id
    `;

    // Tal cual vienen de un libro de ventas por producto y uno de compras por proveedor:
    // identifican la fila, pero ninguno escribe una descripción.
    const sinDescripcion = [
      { product: 'Kapel Blend', counterparty: null },
      { product: 'Kapel Blend', counterparty: null },
      { product: null, counterparty: 'Distribuidora Norte' },
    ];
    for (const f of sinDescripcion) {
      await owner`
        insert into staging_rows (company_id, document_id, target_entity, payload, confidence,
                                  flag_reason, review_status)
        values (${companyId}, ${doc!.id}, 'transaction',
                ${owner.json({
                  type: 'opex',
                  category: null,
                  date: '2026-07-15',
                  originalAmount: 100,
                  originalCurrency: 'GTQ',
                  description: null,
                  product: f.product,
                  counterparty: f.counterparty,
                })},
                0.35, 'low_confidence:0.35', 'pending')
      `;
    }

    const res = await pedir(`/${doc!.id}/conceptos-pendientes`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      conceptos: { concepto: string; ejemplo: string; filas: number }[];
      total: number;
    };

    // Dos conceptos —el producto y el proveedor—, no cero y tampoco tres.
    expect(body.total).toBe(2);
    expect(body.conceptos).toHaveLength(2);

    const porEjemplo = new Map(body.conceptos.map((c) => [c.ejemplo, c]));
    expect([...porEjemplo.keys()].sort()).toEqual(['Distribuidora Norte', 'Kapel Blend']);
    // Las dos filas del mismo producto son UNA pregunta.
    expect(porEjemplo.get('Kapel Blend')?.filas).toBe(2);

    // Y el ejemplo es el texto que el cliente escribió, nunca la palabra "null".
    for (const c of body.conceptos) expect(c.ejemplo).not.toBe('null');
  });

  test('el documento de otra empresa da 404, no sus conceptos', async () => {
    /*
     * ═══ QUÉ CAPA ES LA QUE SOSTIENE ESTO — MEDIDO, NO SUPUESTO ═══
     *
     * Escribí primero que acá se comprobaba el FILTRO de la consulta. Es falso, y la mutación
     * lo dijo: quitando `eq(documents.companyId, companyId)` del handler, esta prueba SIGUE
     * pasando. Lo que devuelve el 404 es **RLS** — la política `documents_tenant_isolation`
     * filtra por el GUC `app.company_id`, y la app conecta como `macha_app` (no dueño), así
     * que `FORCE ROW LEVEL SECURITY` también la sujeta.
     *
     * O sea: la enforcement real es la base; el filtro explícito del handler es defensa en
     * profundidad y este test no lo cubre. Vale saberlo por dos motivos: para no creer que
     * este archivo protege algo que no protege, y porque si algún día la app volviera a
     * conectar como dueño —`APP_DATABASE_URL` sin setear, que es un fallback real— el filtro
     * del handler pasaría a ser lo ÚNICO, sin que ningún test avise.
     *
     * El filtro se escribe igual y se queda: es la regla que el proyecto no negocia, y una
     * consulta correcta por accidente deja de serlo la primera vez que alguien la copia.
     */
    const [otra] = await owner`
      insert into companies (workos_org_id, name, industry)
      values (${`wos_otra_${SUFIJO}`}, ${`Otra ${SUFIJO}`}, 'retail') returning id
    `;
    const [ajeno] = await owner`
      insert into documents (company_id, uploaded_by, s3_key, original_filename,
                             file_size_bytes, mime_type, status)
      values (${otra!.id}, ${userId}, 'x/y.xlsx', 'y.xlsx', 10, 'text/csv', 'promoted')
      returning id
    `;
    const r = await pedir(`/${ajeno!.id}/conceptos-pendientes`);
    expect(r.status).toBe(404);
  });
});

describe('POST /documents/:id/conceptos', () => {
  test('contestar arregla las filas de ESTA carga y encola su promoción', async () => {
    /*
     * ═══ LA ASERCIÓN QUE HACE ÚTIL LA PANTALLA ═══
     *
     * Sin esto el cliente contestaría, la regla quedaría guardada para la próxima carga, y su
     * dashboard de HOY seguiría exactamente igual. La pregunta se sentiría un trámite, y con
     * razón.
     */
    const r = await pedir(`/${documentId}/conceptos`, {
      method: 'POST',
      body: JSON.stringify({
        respuestas: [
          { concepto: claveDeConcepto('Pago a CLARO'), type: 'opex', category: 'servicios' },
          { concepto: claveDeConcepto('Flete Cropa'), type: 'cogs', category: 'transporte' },
        ],
      }),
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { filasResueltas: number; reglasGuardadas: number };

    // Las seis de "claro" (escrito de dos formas) más las dos de "cropa" (GTQ y USD).
    // La de `invalid_date` no: su problema es el dato, no el nombre.
    expect(body.filasResueltas).toBe(8);
    expect(body.reglasGuardadas).toBe(2);

    const aprobadas = await owner`
      select payload, confidence, flag_reason, review_status, reviewed_by
      from staging_rows
      where document_id = ${documentId} and review_status = 'approved'
    `;
    expect(aprobadas.length).toBe(8);
    for (const a of aprobadas) {
      // `flag_reason` a null y confianza 1: lo dijo el dueño de la contabilidad. Si se dejara
      // la confianza baja que la marcó, `staging-rules` la volvería a marcar por
      // `low_confidence` y la respuesta del cliente no serviría de nada.
      expect(a.flag_reason).toBeNull();
      expect(Number(a.confidence)).toBe(1);
      expect(a.reviewed_by).toBe(userId);
    }

    // Y cada fila quedó con la categoría de SU concepto, no todas con la primera.
    const claro = aprobadas.filter(
      (a) => (a.payload as { category: string }).category === 'servicios',
    );
    const cropa = aprobadas.filter(
      (a) => (a.payload as { category: string }).category === 'transporte',
    );
    expect(claro.length).toBe(6);
    // Las dos de "cropa", en las dos monedas: la respuesta se aplica por CONCEPTO, y la moneda
    // de la fila no cambia qué es el concepto.
    expect(cropa.length).toBe(2);
    // El `type` también viaja: "flete" puede ser costo directo o gasto, y son rubros
    // distintos del dashboard.
    expect((cropa[0]!.payload as { type: string }).type).toBe('cogs');

    // Cierra el ciclo: lo aprobado tiene que entrar a la contabilidad, por el MISMO camino
    // que usa el staff al resolver una fila.
    expect(encolados.filter((e) => e.queue === 'document.promote')).toHaveLength(1);
    expect(encolados.at(-1)!.payload).toMatchObject({ documentId, companyId });
  });

  test('la respuesta queda aprendida, con la autoridad del cliente', async () => {
    /*
     * La mitad que evita volver a preguntar. `confirmado_por_cliente` es la autoridad más alta
     * del diccionario: ninguna inferencia posterior del modelo la pisa, así que el cliente no
     * vuelve a contestar lo mismo la semana que viene.
     */
    const reglas = await owner`
      select concepto, category, type, source, created_by
      from company_category_rules where company_id = ${companyId} order by category
    `;
    expect(reglas.length).toBe(2);
    for (const g of reglas) {
      expect(g.source).toBe('confirmado_por_cliente');
      expect(g.created_by).toBe(userId);
    }

    // Y se encuentra por el mismo camino que usa la ingesta para no volver a preguntar.
    const db = drizzle(owner, { schema }) as never;
    const d = await DiccionarioDeCategorias.cargar(db, companyId);
    expect(d.buscar('Pago a CLARO')?.category).toBe('servicios');
    expect(d.buscar('pago claro')?.source).toBe('confirmado_por_cliente');
  });

  test('la fila de problema de DATO sigue pendiente, no se dio por resuelta', async () => {
    // Contestar categorías no la arregla, y darla por resuelta la promovería con una fecha
    // ilegible. Sigue esperando a quien pueda mirar el archivo.
    const pendientes = await owner`
      select flag_reason from staging_rows
      where document_id = ${documentId} and review_status = 'pending'
    `;
    expect(pendientes.length).toBe(1);
    expect(pendientes[0]!.flag_reason).toBe('invalid_date');
  });

  test('contestar de nuevo no duplica reglas ni vuelve a resolver filas', async () => {
    /*
     * El cliente aprieta dos veces, o recarga y reenvía. La tabla es append-only: si cada
     * envío escribiera una versión nueva, el diccionario crecería sin aprender nada — y no se
     * puede limpiar después.
     */
    const antes = await unNumero(
      owner`select count(*)::int as n from company_category_rules where company_id = ${companyId}`,
    );

    const r = await pedir(`/${documentId}/conceptos`, {
      method: 'POST',
      body: JSON.stringify({
        respuestas: [
          { concepto: claveDeConcepto('Pago a CLARO'), type: 'opex', category: 'servicios' },
        ],
      }),
    });
    const body = (await r.json()) as { filasResueltas: number; reglasGuardadas: number };

    // Ninguna fila queda por resolver (ya están `approved`) y la regla no se reescribe.
    expect(body.filasResueltas).toBe(0);
    expect(body.reglasGuardadas).toBe(0);
    expect(
      await unNumero(
        owner`select count(*)::int as n from company_category_rules
              where company_id = ${companyId}`,
      ),
    ).toBe(antes);
  });

  test('un `type` inventado se rechaza en el borde', async () => {
    /*
     * Si pasara, `staging-rules` volvería a marcar la fila por `invalid_type` y el cliente
     * habría contestado para nada. Lo ataja el esquema, que es donde tiene que atajarse.
     */
    const r = await pedir(`/${documentId}/conceptos`, {
      method: 'POST',
      body: JSON.stringify({
        respuestas: [{ concepto: 'pago|claro', type: 'ganancias', category: 'x' }],
      }),
    });
    expect(r.status).toBe(422);
  });

  test('no se puede contestar por el documento de otra empresa', async () => {
    const [otra] = await owner`
      insert into companies (workos_org_id, name, industry)
      values (${`wos_otra2_${SUFIJO}`}, ${`Otra2 ${SUFIJO}`}, 'retail') returning id
    `;
    const [ajeno] = await owner`
      insert into documents (company_id, uploaded_by, s3_key, original_filename,
                             file_size_bytes, mime_type, status)
      values (${otra!.id}, ${userId}, 'x/z.xlsx', 'z.xlsx', 10, 'text/csv', 'promoted')
      returning id
    `;
    const r = await pedir(`/${ajeno!.id}/conceptos`, {
      method: 'POST',
      body: JSON.stringify({
        respuestas: [{ concepto: 'pago|claro', type: 'opex', category: 'servicios' }],
      }),
    });
    expect(r.status).toBe(404);

    // Y no escribió una regla en la empresa ajena, que sería el fallo silencioso: su
    // contabilidad clasificada con reglas de otro.
    expect(
      await unNumero(
        owner`select count(*)::int as n from company_category_rules
              where company_id = ${otra!.id}`,
      ),
    ).toBe(0);
  });
});
