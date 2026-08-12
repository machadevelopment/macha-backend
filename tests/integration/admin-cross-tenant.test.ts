import { describe, expect, test, beforeAll, afterAll, mock } from 'bun:test';
import { Elysia } from 'elysia';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  setupTestDatabase,
  ownerConnection,
  appConnection,
  testOwnerUrl,
  testAppUrl,
} from './setup';

/**
 * CU-868kjc4af: el panel admin ve TODAS las empresas con el rol `macha_app`, y nadie
 * más puede abrir esa puerta.
 *
 * El bug: `admin.guard` y los módulos `/admin/*` consultaban con el pool sin GUC, y
 * bajo `macha_app` toda tabla con RLS devolvía cero filas — con un 200, no con un
 * error. La salida es `app.cross_tenant = 'on'`, que solo setea el guard tras
 * verificar la fila en `staff`.
 *
 * Este archivo prueba las dos mitades, y la segunda importa más que la primera: que el
 * admin vea es una funcionalidad, que nadie más pueda ver es la garantía.
 */

process.env.DATABASE_URL = testOwnerUrl;
process.env.APP_DATABASE_URL = testAppUrl;
process.env.WORKOS_JWKS_URL = 'https://example.invalid/jwks';

mock.module('@/lib/auth', () => ({
  verifyToken: async (token: string) => {
    if (token === 'invalid') throw new Error('bad signature');
    return { sub: token };
  },
}));

const { adminGuard } = await import('@/guards/admin.guard');
const { tenantDerive } = await import('@/guards/tenant.derive');
const { documents } = await import('@/db/schema');

// Dos apps separadas, como en producción: el namespace admin NO cuelga de tenantDerive
// (CU-868kfvaex). Montarlas juntas escondería justamente lo que hay que comprobar.
const adminApp = new Elysia()
  .use(adminGuard)
  .get('/admin/documents', async ({ db }) => db.select().from(documents));

const tenantApp = new Elysia()
  .use(tenantDerive)
  .get('/documents', async ({ db }) => db.select().from(documents));

describe('visibilidad cross-tenant del admin (CU-868kjc4af)', () => {
  let owner: ReturnType<typeof ownerConnection>;
  let companyA: string;
  let companyB: string;

  beforeAll(async () => {
    await setupTestDatabase();
    owner = ownerConnection();

    const [a] = await owner`insert into companies (workos_org_id, name, industry)
      values ('org_x_a', 'Cross Alfa', 'retail') returning id`;
    const [b] = await owner`insert into companies (workos_org_id, name, industry)
      values ('org_x_b', 'Cross Beta', 'retail') returning id`;
    companyA = a!.id;
    companyB = b!.id;

    const [staffUser] = await owner`insert into users (workos_user_id, email)
      values ('wos_x_staff', 'xstaff@test.local') returning id`;
    await owner`insert into staff (user_id, tier) values (${staffUser!.id}, 'super_admin')`;

    // Cliente de A: miembro legítimo de una sola empresa, sin fila en `staff`.
    const [client] = await owner`insert into users (workos_user_id, email)
      values ('wos_x_client', 'xclient@test.local') returning id`;
    await owner`insert into company_users (company_id, user_id, role)
      values (${companyA}, ${client!.id}, 'owner')`;

    for (const [companyId, filename] of [
      [companyA, 'cross-alfa.xlsx'],
      [companyB, 'cross-beta.xlsx'],
    ] as const) {
      await owner`
        insert into documents (company_id, uploaded_by, s3_key, original_filename,
                               file_size_bytes, mime_type)
        values (${companyId}, ${staffUser!.id}, ${`${companyId}/x`}, ${filename}, 100, 'text/csv')
      `;
    }
  });

  afterAll(async () => {
    await owner?.end();
  });

  test('un staff ve los documentos de las DOS empresas', async () => {
    // El bug exacto: esto devolvía [] y el monitoreo de uploads se veía sin uploads.
    const res = await adminApp.handle(
      new Request('http://localhost/admin/documents', {
        headers: { authorization: 'Bearer wos_x_staff' },
      }),
    );
    expect(res.status).toBe(200);

    const rows = (await res.json()) as { companyId: string; originalFilename: string }[];
    // Se comprueba por inclusión, no por igualdad: el staff ve TODA la base, incluidos
    // los documentos que sembraron los otros archivos de la suite. Que aparezcan es la
    // confirmación de que esto es cross-company de verdad y no dos empresas afortunadas.
    const nombres = rows.map((r) => r.originalFilename);
    expect(nombres).toContain('cross-alfa.xlsx');
    expect(nombres).toContain('cross-beta.xlsx');
    expect(new Set(rows.map((r) => r.companyId)).size).toBeGreaterThan(1);
  });

  test('un cliente por la cadena de tenant sigue viendo SOLO lo suyo', async () => {
    // La contraparte imprescindible: abrir la vía de staff no puede haber aflojado el
    // aislamiento normal. Si este test se pusiera verde con dos filas, el arreglo
    // habría costado justo lo que 0010 vino a garantizar.
    const res = await tenantApp.handle(
      new Request('http://localhost/documents', {
        headers: { authorization: 'Bearer wos_x_client' },
      }),
    );
    expect(res.status).toBe(200);

    const rows = (await res.json()) as { originalFilename: string }[];
    expect(rows.map((r) => r.originalFilename)).toEqual(['cross-alfa.xlsx']);
  });

  test('un no-staff es rechazado ANTES de que exista conexión con el GUC', async () => {
    // Ser owner de tu empresa no da acceso al backoffice: el gate es `staff`.
    const res = await adminApp.handle(
      new Request('http://localhost/admin/documents', {
        headers: { authorization: 'Bearer wos_x_client' },
      }),
    );
    expect(res.status).toBe(403);
  });

  test('sin bearer token tampoco', async () => {
    const res = await adminApp.handle(new Request('http://localhost/admin/documents'));
    expect(res.status).toBe(401);
  });

  test('el GUC no sobrevive a la request: la siguiente conexión no ve nada', async () => {
    // `SET LOCAL` se revierte al cerrar la transacción. Si se hubiera usado un SET de
    // sesión, la conexión volvería al pool con cross_tenant activo y la siguiente
    // request —de cualquier inquilino— heredaría visibilidad total. Es el peor fallo
    // posible de este diseño, así que se comprueba explícitamente.
    await adminApp.handle(
      new Request('http://localhost/admin/documents', {
        headers: { authorization: 'Bearer wos_x_staff' },
      }),
    );

    const app2 = appConnection();
    try {
      const rows = await app2`select id from documents`;
      expect(rows).toEqual([]);
    } finally {
      await app2.end();
    }
  });

  test('solo admin.guard setea app.cross_tenant en todo el código', async () => {
    // La garantía real del diseño no es una política de base: es que nada más pueda
    // encender el GUC. Un barrido del fuente lo fija — si alguien lo setea desde otro
    // sitio (un módulo, un worker, un helper), este test lo señala por nombre.
    //
    // SI ESTE TEST TE FALLA Y NO ESTÁS SETEANDO EL GUC: el barrido es un regex sobre el
    // texto crudo, así que una simple MENCIÓN en un comentario también lo dispara. Pasó
    // el 2026-08-11 con `modules/admin/company-overview.ts`, que solo lo documentaba.
    //
    // La salida es REFORMULAR EL COMENTARIO ("el escape cross-tenant", "el GUC del
    // guard"), NO afinar el chequeo para que ignore comentarios. Este test vale
    // precisamente por ser tonto: es el único guardia de que nada fuera de `admin.guard`
    // encienda el escape que deja ver datos de todas las empresas, y volverlo "listo" es
    // exactamente lo que abriría la puerta a que algo se cuele. Que no se pueda escribir
    // el nombre del GUC en un comentario es un costo barato al lado de eso.
    const files = sourceFiles(join(import.meta.dir, '..', '..', 'src'));
    const setters = files.filter((f) => /app\.cross_tenant/.test(readFileSync(f, 'utf8')));

    expect(setters.map((f) => f.split('/src/')[1]).sort()).toEqual([
      'guards/admin.guard.ts', // el único que lo setea
      'lib/db-scope.ts', // solo lo declara en el tipo de scopeTo
    ]);
  });
});

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return full.endsWith('.ts') && !full.endsWith('.test.ts') ? [full] : [];
  });
}
