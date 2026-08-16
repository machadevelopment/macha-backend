import { describe, expect, test, beforeAll, afterAll } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/postgres-js';
import { setupTestDatabase, ownerConnection } from './setup';
import * as schema from '@/db/schema';
import { guardarPerfil, perfilVigente } from '@/lib/column-profile';
import type { ColumnMap } from '@/lib/row-assembly';

/**
 * El perfil de mapeo por empresa contra Postgres real (CU-868krmrcj, migración `0027`).
 *
 * Se prueba acá y no en unitarios porque lo que puede fallar vive en la base: el
 * versionado, el aislamiento entre empresas y que dos cargas del mismo layout no llenen la
 * tabla de filas idénticas. Nada de eso se puede comprobar con un mock — un mock haría
 * exactamente lo que el código le pida.
 *
 * (Que `macha_app` no pueda hacer UPDATE ni DELETE sobre esta tabla lo cubre
 * `append-only.test.ts`, que la recorre junto con los otros siete ledgers.)
 */
describe('perfil de columnas por empresa', () => {
  let owner: ReturnType<typeof ownerConnection>;
  const empresaA = randomUUID();
  const empresaB = randomUUID();

  const VENTAS = ['Fecha', 'Producto', 'Cantidad', 'Precio Unitario (Q)', 'Ingreso Total (Q)'];

  const MAPA: ColumnMap = {
    date: 0,
    amount: 4,
    currency: null,
    description: null,
    counterparty: null,
    product: 1,
    quantity: 2,
    productCategory: null,
    dueDate: null,
    costTotal: null,
    costUnit: null,
  };

  beforeAll(async () => {
    await setupTestDatabase();
    owner = ownerConnection();
    for (const id of [empresaA, empresaB]) {
      await owner`
        insert into companies (id, workos_org_id, name, industry, base_currency, locale)
        values (${id}, ${'org_' + id}, ${'Perfil ' + id}, 'retail', 'GTQ', 'es')
      `;
    }
  });

  afterAll(async () => {
    await owner?.end();
  });

  const db = () => drizzle(owner, { schema });

  test('sin perfil guardado devuelve null, no revienta', async () => {
    // Es el estado de TODA empresa antes de su primera carga, así que no puede ser un error.
    expect(await perfilVigente(db(), empresaA, VENTAS)).toBeNull();
  });

  test('lo que se guarda es lo que se lee', async () => {
    const { version, escrito } = await guardarPerfil(db(), {
      companyId: empresaA,
      headerRow: VENTAS,
      sheetName: 'Ventas',
      columnMap: MAPA,
      source: 'inferido',
    });
    expect({ version, escrito }).toEqual({ version: 1, escrito: true });

    const perfil = await perfilVigente(db(), empresaA, VENTAS);
    expect(perfil?.columnMap).toEqual(MAPA);
    expect(perfil?.version).toBe(1);
    // Los encabezados normalizados se guardan para poder diagnosticar sin adivinar.
    expect(perfil?.headers).toEqual([
      'fecha',
      'producto',
      'cantidad',
      'preciounitario',
      'ingresototal',
    ]);
  });

  test('reguardar lo MISMO no crea una versión nueva', async () => {
    // El caso del cliente que resube su contabilidad cada semana. Sin este corte, la tabla
    // crecería sin parar diciendo siempre lo mismo y la pregunta que existe para contestar
    // —"¿cuándo cambió el mapa?"— quedaría enterrada bajo cientos de filas que no son cambios.
    const r = await guardarPerfil(db(), {
      companyId: empresaA,
      headerRow: VENTAS,
      sheetName: 'Ventas',
      columnMap: MAPA,
      source: 'inferido',
    });
    expect(r).toEqual({ version: 1, escrito: false });

    const [{ count }] = await owner`
      select count(*)::int as count from company_column_profiles
      where company_id = ${empresaA}
    `;
    expect(count).toBe(1);
  });

  test('un mapa distinto SÍ crea una versión nueva, y la vigente es la última', async () => {
    const movido: ColumnMap = { ...MAPA, amount: 7 };
    const r = await guardarPerfil(db(), {
      companyId: empresaA,
      headerRow: VENTAS,
      sheetName: 'Ventas',
      columnMap: movido,
      source: 'inferido',
    });
    expect(r).toEqual({ version: 2, escrito: true });

    const perfil = await perfilVigente(db(), empresaA, VENTAS);
    expect(perfil?.version).toBe(2);
    expect(perfil?.columnMap).toEqual(movido);
  });

  test('la versión anterior SIGUE ahí — es todo el punto del append-only', async () => {
    // Cuando un mapa equivocado desplace la contabilidad de una hoja, la única pregunta útil
    // es "¿con qué mapa se leyó la carga del martes?". Solo se contesta si esto sigue acá.
    const filas = await owner`
      select version from company_column_profiles
      where company_id = ${empresaA} order by version
    `;
    expect(filas.map((f) => f.version)).toEqual([1, 2]);
  });

  test('el mismo origen con distinto mapa versiona; el mismo mapa con distinto origen también', async () => {
    // Que un humano CONFIRME lo que el modelo ya había inferido es un hecho que vale
    // registrar, aunque el mapa no cambie ni una columna.
    const vigente = (await perfilVigente(db(), empresaA, VENTAS))!;
    const r = await guardarPerfil(db(), {
      companyId: empresaA,
      headerRow: VENTAS,
      sheetName: 'Ventas',
      columnMap: vigente.columnMap,
      source: 'confirmado_por_cliente',
    });
    expect(r.escrito).toBe(true);
    expect((await perfilVigente(db(), empresaA, VENTAS))?.source).toBe('confirmado_por_cliente');
  });

  test('el perfil de una empresa NO se le aplica a otra', async () => {
    // El fallo que esto evita no es una fuga de lectura: es que el mapa de otra empresa se
    // use para leer este archivo. No falla, lee la columna de al lado.
    expect(await perfilVigente(db(), empresaB, VENTAS)).toBeNull();
  });

  test('un layout distinto de la MISMA empresa es otro perfil, con su propia versión 1', async () => {
    const conCosto = [...VENTAS, 'Costo Total (Q)'];
    const r = await guardarPerfil(db(), {
      companyId: empresaA,
      headerRow: conCosto,
      sheetName: 'Ventas',
      columnMap: { ...MAPA, costTotal: 5 },
      source: 'inferido',
    });
    // Versión 1 y no 4: el versionado es por (empresa, estructura), no por empresa.
    expect(r).toEqual({ version: 1, escrito: true });

    // Y el perfil del layout viejo no se tocó.
    expect((await perfilVigente(db(), empresaA, VENTAS))?.source).toBe('confirmado_por_cliente');
  });
});
