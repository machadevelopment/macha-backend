import { describe, expect, test, beforeAll, afterAll, mock } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { Elysia } from 'elysia';
import * as XLSX from 'xlsx';
import { setupTestDatabase, ownerConnection, testOwnerUrl, testAppUrl } from './setup';

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════
 * LA PLANTILLA DESCARGABLE POR INDUSTRIA — CURADA SI HAY, GENERADA SI NO
 * ═══════════════════════════════════════════════════════════════════════════════════════
 *
 * Jose (2026-08-20): que el equipo pueda subir una plantilla por industria para el cliente que
 * no tiene ningún Excel armado.
 *
 * ═══ QUÉ SE PRUEBA, Y POR QUÉ NINGUNA DE LAS TRES COSAS HACE RUIDO SI SE ROMPE ═══
 *
 *  1. **Que la curada gane.** Si el orden se invierte, el cliente recibe el archivo genérico
 *     y nadie se entera: es un .xlsx válido, se descarga bien, y el trabajo de quien armó el
 *     bueno simplemente no llega. No hay error que mirar.
 *  2. **Que SIEMPRE llegue un archivo.** Es el criterio del ticket ("si una industria no tiene
 *     plantilla cargada, el onboarding no rompe ni muestra un enlace roto") y la razón por la
 *     que el fallback no es un resto del diseño viejo: es lo que permite que el frontend no
 *     tenga ningún condicional.
 *  3. **Que un objeto de S3 ilegible caiga al generado en vez de dar 500.** Un cliente en
 *     onboarding que aprieta "descargar plantilla" y recibe un error no vuelve a intentarlo.
 *
 * Corre los endpoints reales contra Postgres real. Solo se falsea la firma del JWT y S3.
 */

process.env.DATABASE_URL = testOwnerUrl;
process.env.APP_DATABASE_URL = testAppUrl;
process.env.WORKOS_JWKS_URL = 'https://example.invalid/jwks';

mock.module('@/lib/auth', () => ({
  verifyToken: async (token: string) => ({ sub: token }),
}));

/**
 * S3 falseado, con un mapa de clave → bytes.
 *
 * Se conserva el módulo real con el spread: un doble parcial de `@/lib/s3` BORRA el resto de
 * sus exports —`uploadKey`, `industryStarterKey`— y como `mock.module` es global al proceso, el
 * primer archivo que importe uno de ellos muere con un `SyntaxError` que no menciona ni este
 * archivo ni este mock. Ya pasó (ver `doble-de-cola.ts`).
 */
const s3Real = await import('@/lib/s3');
const objetos = new Map<string, Uint8Array>();
/** Claves cuya lectura debe FALLAR, para probar el caso del objeto ilegible. */
const ilegibles = new Set<string>();

mock.module('@/lib/s3', () => ({
  ...s3Real,
  uploadObject: async (key: string, body: Uint8Array) => {
    objetos.set(key, body);
  },
  downloadObject: async (key: string) => {
    if (ilegibles.has(key)) throw new Error('NoSuchKey');
    const bytes = objetos.get(key);
    if (!bytes) throw new Error(`NoSuchKey: ${key}`);
    return bytes;
  },
}));

const { industryTemplateDownload } = await import('@/modules/industry-templates');
const { adminIndustryTemplates } = await import('@/modules/admin/industry-templates');
const { industryStarterKey } = await import('@/lib/s3');

const app = new Elysia().use(industryTemplateDownload).use(adminIndustryTemplates);

const SUFIJO = randomUUID().slice(0, 8);
const WOS_CLIENTE = `wos_plantilla_${SUFIJO}`;
const WOS_STAFF = `wos_plantilla_staff_${SUFIJO}`;
/** Con mayúscula a propósito: es lo que obliga a normalizar en los dos lados. */
const INDUSTRIA = `Cafeteria${SUFIJO}`;

const owner = ownerConnection();
let companyId: string;

function pedirDescarga() {
  return app.handle(
    new Request('http://localhost/industry-templates/download', {
      headers: { authorization: `Bearer ${WOS_CLIENTE}` },
    }),
  );
}

function libroCurado(nota: string): Blob {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.aoa_to_sheet([
      ['fecha', 'concepto', 'monto'],
      [nota, 'curada', 1],
    ]),
    'Ventas',
  );
  return new Blob([XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
}

async function subirCurada(nombre: string, nota: string) {
  const fd = new FormData();
  fd.append('file', libroCurado(nota), nombre);
  fd.append('notes', nota);
  return app.handle(
    new Request(`http://localhost/admin/industry-templates/starters/${INDUSTRIA}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${WOS_STAFF}` },
      body: fd,
    }),
  );
}

beforeAll(async () => {
  await setupTestDatabase();

  const [c] = await owner`
    insert into companies (workos_org_id, name, industry, base_currency)
    values (${`wos_org_pl_${SUFIJO}`}, ${`Plantilla ${SUFIJO}`}, ${INDUSTRIA}, 'GTQ')
    returning id
  `;
  companyId = c!.id;

  const [uc] = await owner`
    insert into users (workos_user_id, email)
    values (${WOS_CLIENTE}, ${`pl-cli-${SUFIJO}@test.local`}) returning id
  `;
  await owner`
    insert into company_users (company_id, user_id, role)
    values (${companyId}, ${uc!.id}, 'owner')
  `;

  const [us] = await owner`
    insert into users (workos_user_id, email)
    values (${WOS_STAFF}, ${`pl-staff-${SUFIJO}@test.local`}) returning id
  `;
  await owner`insert into staff (user_id, tier) values (${us!.id}, 'super_admin')`;
});

afterAll(async () => {
  await owner?.end();
});

/** Lee el .xlsx que devolvió la ruta y saca la primera celda, para distinguir cuál llegó. */
async function primeraCelda(res: Response): Promise<string> {
  const wb = XLSX.read(new Uint8Array(await res.arrayBuffer()), { type: 'array' });
  const hoja = wb.Sheets[wb.SheetNames[0]!]!;
  const filas = XLSX.utils.sheet_to_json<unknown[]>(hoja, { header: 1 });
  return String(filas[1]?.[0] ?? '');
}

describe('sin plantilla curada: SIEMPRE llega un archivo', () => {
  test('la descarga funciona y trae la generada', async () => {
    /*
     * Es el criterio del ticket, y el que hace que el frontend no necesite ningún condicional:
     * la URL responde un .xlsx aunque nadie haya subido nada nunca.
     */
    const r = await pedirDescarga();
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toContain('spreadsheetml');

    const bytes = new Uint8Array(await r.arrayBuffer());
    expect(bytes.length).toBeGreaterThan(0);
    // La generada nombra sus hojas "Transacciones"; la curada de este test, "Ventas".
    const wb = XLSX.read(bytes, { type: 'array' });
    expect(wb.SheetNames).toContain('Transacciones');
  });
});

describe('con plantilla curada: gana la curada', () => {
  test('staff la sube y queda como versión 1', async () => {
    const r = await subirCurada('plantilla-cafeteria.xlsx', 'primera');
    expect(r.status).toBe(200);
    const body = (await r.json()) as { version: number; industry: string };
    expect(body.version).toBe(1);
    // La industria se guarda NORMALIZADA, no como vino en la URL.
    expect(body.industry).toBe(INDUSTRIA.toLowerCase());

    // Y el objeto quedó en S3 con la versión en la clave: sin eso, la siguiente subida
    // sobreescribiría estos bytes y la fila v1 apuntaría a un archivo que no es el suyo.
    expect(objetos.has(industryStarterKey(INDUSTRIA.toLowerCase(), 1, 'xlsx'))).toBe(true);
  });

  test('el cliente ahora recibe LA CURADA, no la generada', async () => {
    /*
     * La aserción central del ticket. Si el orden se invirtiera, el cliente seguiría recibiendo
     * un .xlsx perfectamente válido y el trabajo de quien armó el bueno no llegaría nunca —
     * sin un error que mirar.
     */
    const r = await pedirDescarga();
    expect(r.status).toBe(200);
    expect(await primeraCelda(r)).toBe('primera');
    expect(r.headers.get('content-disposition')).toContain('plantilla-cafeteria.xlsx');
  });

  test('la industria casa aunque la empresa la tenga escrita distinto', async () => {
    /*
     * La empresa se creó con `Cafeteria…` en mayúscula y la subida normaliza a minúscula. Sin
     * `normalizeIndustry` en LOS DOS lados serían dos industrias distintas y la empresa recibiría
     * la genérica para siempre, con la curada guardada al lado.
     */
    const [fila] = await owner`
      select industry from industry_starter_templates
      where industry = ${INDUSTRIA.toLowerCase()} limit 1
    `;
    expect(fila).toBeDefined();
    const [empresa] = await owner`select industry from companies where id = ${companyId}`;
    expect(empresa!.industry).not.toBe(fila!.industry); // escritas distinto…
    expect(await primeraCelda(await pedirDescarga())).toBe('primera'); // …y aun así casa
  });
});

describe('una versión nueva reemplaza a la vigente sin borrar la anterior', () => {
  test('la segunda subida es v2 y es la que se descarga', async () => {
    const r = await subirCurada('plantilla-cafeteria-v2.xlsx', 'segunda');
    expect(((await r.json()) as { version: number }).version).toBe(2);

    expect(await primeraCelda(await pedirDescarga())).toBe('segunda');
  });

  test('la v1 sigue en la base Y su objeto sigue en S3', async () => {
    /*
     * Append-only, y las dos mitades importan: la fila permite saber qué se servía antes, y el
     * objeto permite volver atrás. Un UPDATE habría dejado el binario anterior huérfano en el
     * bucket —nadie lo referencia, nadie lo borra— y "volver a la versión anterior" sería
     * imposible.
     */
    const filas = await owner`
      select version from industry_starter_templates
      where industry = ${INDUSTRIA.toLowerCase()} order by version
    `;
    expect(filas.map((f) => f.version)).toEqual([1, 2]);
    expect(objetos.has(industryStarterKey(INDUSTRIA.toLowerCase(), 1, 'xlsx'))).toBe(true);
    expect(objetos.has(industryStarterKey(INDUSTRIA.toLowerCase(), 2, 'xlsx'))).toBe(true);
  });

  test('la subida quedó auditada, las dos veces', async () => {
    // Toda mutación de `/admin/*` escribe `admin_audit_log`. Es regla del proyecto y acá además
    // es lo único que dice quién cambió la plantilla que ve un cliente.
    const [n] = await owner`
      select count(*)::int as n from admin_audit_log
      where action = 'industry_starter_template.upload'
    `;
    expect(n!.n).toBeGreaterThanOrEqual(2);
  });
});

describe('si el objeto de S3 no se puede leer, NO se cae la descarga', () => {
  test('vuelve la generada en vez de un 500', async () => {
    /*
     * La fila está en la base y el objeto no (borrado a mano, bucket mal configurado). Devolver
     * 500 sería lo "correcto" en abstracto y lo peor para el cliente: está en onboarding, apretó
     * "descargar plantilla", y un error ahí es alguien que abandona.
     */
    ilegibles.add(industryStarterKey(INDUSTRIA.toLowerCase(), 2, 'xlsx'));

    const r = await pedirDescarga();
    expect(r.status).toBe(200);
    const wb = XLSX.read(new Uint8Array(await r.arrayBuffer()), { type: 'array' });
    expect(wb.SheetNames).toContain('Transacciones');

    ilegibles.clear();
  });
});

describe('el borde de la subida', () => {
  test('un tipo que no es hoja de cálculo se rechaza', async () => {
    const fd = new FormData();
    fd.append('file', new Blob(['hola'], { type: 'text/plain' }), 'notas.txt');
    const r = await app.handle(
      new Request(`http://localhost/admin/industry-templates/starters/${INDUSTRIA}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${WOS_STAFF}` },
        body: fd,
      }),
    );
    expect(r.status).toBe(415);
  });

  test('un cliente NO puede subir una plantilla de plataforma', async () => {
    /*
     * La tabla no lleva RLS —es catálogo de plataforma, no tiene `company_id` que aislar—, así
     * que lo único que la protege es el guard de `/admin/*`. Por eso esto se prueba: acá el
     * guard no es defensa en profundidad, es la defensa.
     */
    const fd = new FormData();
    fd.append('file', libroCurado('intruso'), 'x.xlsx');
    const r = await app.handle(
      new Request(`http://localhost/admin/industry-templates/starters/${INDUSTRIA}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${WOS_CLIENTE}` },
        body: fd,
      }),
    );
    expect(r.status).toBeGreaterThanOrEqual(400);

    // Y no escribió nada: sin esto, un 4xx con la fila insertada pasaría por bueno.
    const [n] = await owner`
      select count(*)::int as n from industry_starter_templates
      where industry = ${INDUSTRIA.toLowerCase()}
    `;
    expect(n!.n).toBe(2);
  });
});
