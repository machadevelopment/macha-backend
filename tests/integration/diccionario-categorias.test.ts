import { describe, expect, test, beforeAll, afterAll } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/postgres-js';
import { ownerConnection, setupTestDatabase } from './setup';
import * as schema from '@/db/schema';
import {
  DiccionarioDeCategorias,
  guardarReglasAprendidas,
  claveDeConcepto,
} from '@/lib/category-dictionary';
import type { DB } from '@/db/client';

/**
 * Diccionario de categorías por empresa — acuerdo Keneth–Semi, 2026-08-20.
 *
 * Contra Postgres real y no con mocks, porque lo que puede fallar acá no es la lógica: es la
 * tabla. El cálculo de la versión, el índice UNIQUE que arbitra las cargas simultáneas y el
 * append-only del rol de aplicación solo existen en la base.
 */

const COMPANY_ORG = 'org_diccionario';

describe('diccionario de categorías por empresa', () => {
  let owner: ReturnType<typeof ownerConnection>;
  let db: DB;
  let companyId: string;
  let otraEmpresa: string;

  beforeAll(async () => {
    await setupTestDatabase();
    owner = ownerConnection();
    db = drizzle(owner, { schema }) as unknown as DB;

    const [c] = await owner`
      insert into companies (workos_org_id, name, industry)
      values (${COMPANY_ORG}, ${'Diccionario ' + randomUUID()}, 'retail') returning id
    `;
    companyId = c!.id;

    const [o] = await owner`
      insert into companies (workos_org_id, name, industry)
      values (${'org_dicc_otra_' + randomUUID()}, ${'Otra ' + randomUUID()}, 'retail') returning id
    `;
    otraEmpresa = o!.id;
  });

  afterAll(async () => {
    await owner?.end();
  });

  test('lo aprendido en una carga se encuentra en la siguiente', async () => {
    // El punto entero: la primera carga paga la clasificación, la segunda la lee.
    const escritas = await guardarReglasAprendidas(db, companyId, [
      { texto: 'Pago a Claro', entity: 'transaction', type: 'opex', category: 'servicios' },
      { texto: 'Flete Cropa', entity: 'transaction', type: 'cogs', category: 'transporte' },
    ]);
    expect(escritas).toBe(2);

    const d = await DiccionarioDeCategorias.cargar(db, companyId);
    expect(d.buscar('pago claro')?.category).toBe('servicios');
    expect(d.buscar('FLETE CROPA')?.category).toBe('transporte');
    // El tipo viaja con la categoría: "flete" puede ser costo directo o gasto operativo.
    expect(d.buscar('Flete Cropa')?.type).toBe('cogs');
  });

  test('un concepto ya sabido no se vuelve a escribir', async () => {
    /*
     * Una hoja de 18.000 movimientos tiene decenas de conceptos distintos. Sin esto, cada
     * carga insertaría una regla por FILA y el diccionario sería una copia del ledger — y como
     * la tabla es append-only, para siempre.
     */
    const escritas = await guardarReglasAprendidas(db, companyId, [
      { texto: 'pago a claro', entity: 'transaction', type: 'opex', category: 'otra_cosa' },
    ]);

    expect(escritas).toBe(0);
    // Y la regla original queda intacta: lo inferido no pisa lo inferido.
    const d = await DiccionarioDeCategorias.cargar(db, companyId);
    expect(d.buscar('pago a claro')?.category).toBe('servicios');
  });

  test('lo que confirma el cliente SÍ pisa lo inferido, con versión nueva', async () => {
    // La mitad del acuerdo con Semi: el cliente entra al flujo porque sabe qué es "Cropa".
    const escritas = await guardarReglasAprendidas(
      db,
      companyId,
      [{ texto: 'Flete Cropa', entity: 'transaction', type: 'opex', category: 'fletes' }],
      { source: 'confirmado_por_cliente' },
    );
    expect(escritas).toBe(1);

    const d = await DiccionarioDeCategorias.cargar(db, companyId);
    expect(d.buscar('flete cropa')?.category).toBe('fletes');
    expect(d.buscar('flete cropa')?.source).toBe('confirmado_por_cliente');

    // La versión anterior NO se borró: es lo que permite contestar "¿con qué regla se
    // clasificó la carga del martes?".
    const filas = await owner`
      select version, source from company_category_rules
      where company_id = ${companyId} and concepto = ${claveDeConcepto('Flete Cropa')}
      order by version
    `;
    expect(filas).toHaveLength(2);
    expect(filas[0]!.source).toBe('inferido');
    expect(filas[1]!.source).toBe('confirmado_por_cliente');
  });

  test('una carga posterior del modelo NO revierte lo que el cliente confirmó', async () => {
    /*
     * El caso que hace útil el orden autoridad→versión. Si el modelo pudiera pisarlo, al
     * cliente se le volvería a preguntar algo que ya contestó — que es exactamente lo que
     * este mecanismo viene a evitar.
     */
    await guardarReglasAprendidas(db, companyId, [
      { texto: 'flete cropa', entity: 'transaction', type: 'cogs', category: 'transporte' },
    ]);

    const d = await DiccionarioDeCategorias.cargar(db, companyId);
    expect(d.buscar('flete cropa')?.category).toBe('fletes');
  });

  test('el diccionario de una empresa NO se ve desde otra', async () => {
    /*
     * "Pago a Claro = servicios" es cierto para una PYME y puede ser falso para la de al lado.
     * Sin aislamiento no sería solo fuga: clasificaría la contabilidad de la vecina con reglas
     * ajenas, en silencio.
     *
     * Se comprueba el FILTRO de la consulta. El backstop de RLS es de `tenant-isolation.test`,
     * que corre con el rol `macha_app`; acá se conecta como dueño (que lo salta por diseño),
     * así que lo que se prueba es que la app no dependa de él.
     */
    const d = await DiccionarioDeCategorias.cargar(db, otraEmpresa);
    expect(d.tamano).toBe(0);
    expect(d.buscar('pago a claro')).toBeNull();
  });

  test('un concepto sin nada normalizable no llega a la tabla', async () => {
    // Una clave vacía casaría con toda fila sin descripción y clasificaría media hoja.
    const escritas = await guardarReglasAprendidas(db, companyId, [
      { texto: '   ', entity: 'transaction', type: 'opex', category: 'x' },
      { texto: '...', entity: 'transaction', type: 'opex', category: 'x' },
      { texto: null, entity: 'transaction', type: 'opex', category: 'x' },
      // Y una categoría vacía tampoco enseña nada.
      { texto: 'concepto valido', entity: 'transaction', type: 'opex', category: '  ' },
    ]);

    expect(escritas).toBe(0);
  });

  test('el mismo concepto repetido en la misma carga se escribe UNA vez', async () => {
    // Es el caso real: 400 filas de "pago planilla" en la misma hoja.
    const escritas = await guardarReglasAprendidas(
      db,
      companyId,
      Array.from({ length: 50 }, () => ({
        texto: 'Pago de planilla quincena',
        entity: 'transaction' as const,
        type: 'opex' as const,
        category: 'nomina',
      })),
    );

    expect(escritas).toBe(1);
  });
});
