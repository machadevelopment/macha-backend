import { describe, expect, test, beforeAll, afterAll } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/postgres-js';
import { setupTestDatabase, ownerConnection } from './setup';
import * as schema from '@/db/schema';
import { ProductResolver } from '@/lib/product-dimension';

/**
 * La normalización del nombre de producto, contra Postgres real.
 *
 * Es lo que decide si el dashboard muestra un producto o tres. La IA extrae el nombre
 * tal como viene en la celda, y el mismo producto aparece como "Café Antigua", "CAFÉ
 * ANTIGUA" y "café antigua" dentro del MISMO archivo. Sin normalizar, el ranking de más
 * vendidos reparte las ventas entre tres filas y ninguna es la verdadera.
 */
describe('ProductResolver (dimensión de productos)', () => {
  let owner: ReturnType<typeof ownerConnection>;
  const empresa = randomUUID();

  beforeAll(async () => {
    await setupTestDatabase();
    owner = ownerConnection();
    await owner`
      insert into companies (id, workos_org_id, name, industry, base_currency, locale)
      values (${empresa}, ${'org_' + empresa}, ${'Productos ' + empresa}, 'retail', 'GTQ', 'es')
    `;
  });

  afterAll(async () => {
    await owner?.end();
  });

  const resolver = () => new ProductResolver(drizzle(owner, { schema }), empresa);

  test('el mismo nombre en distintas capitalizaciones es UN producto', async () => {
    const r = resolver();
    const a = await r.resolve('Café Antigua');
    const b = await r.resolve('CAFÉ ANTIGUA');
    const c = await r.resolve('  café antigua  ');
    expect(b).toBe(a!);
    expect(c).toBe(a!);
  });

  test('conserva la capitalización de la primera aparición, que es la que el dueño reconoce', async () => {
    const r = resolver();
    await r.resolve('Antigua Reserve 500g');
    await r.resolve('ANTIGUA RESERVE 500G');
    const filas = await owner`
      select name from products where company_id = ${empresa} and lower(name) = 'antigua reserve 500g'
    `;
    expect(filas).toHaveLength(1);
    expect(filas[0]!.name).toBe('Antigua Reserve 500g');
  });

  test('sin producto identificable devuelve null, no inventa uno', async () => {
    // Rellenar con "Sin categoría" crearía un producto fantasma que competiría en el
    // ranking contra los reales.
    const r = resolver();
    expect(await r.resolve(null)).toBeNull();
    expect(await r.resolve(undefined)).toBeNull();
    expect(await r.resolve('   ')).toBeNull();
  });

  test('la categoría se guarda al crear el producto', async () => {
    const r = resolver();
    const id = await r.resolve('Cerveza Gallo 350ml', 'bebidas');
    const [fila] = await owner`select category from products where id = ${id!}`;
    expect(fila!.category).toBe('bebidas');
  });

  test('una fila sin categoría no borra la que el producto ya tenía', async () => {
    // El caso real: el archivo trae la familia comercial en la hoja de ventas y no en la
    // de compras. Si la segunda pisara a la primera, la categoría del producto dependería
    // de en qué orden se procesaron las hojas.
    const r = resolver();
    const id = await r.resolve('Ron Botran Añejo', 'licores');
    await r.resolve('Ron Botran Añejo', null);
    await r.resolve('ron botran añejo');
    const [fila] = await owner`select category from products where id = ${id!}`;
    expect(fila!.category).toBe('licores');
  });

  test('una categoría distinta NO pisa la primera: el resultado no puede depender del orden de las filas', async () => {
    // Dos cargas del mismo Excel tienen que dejar la misma categoría. Si cada fila
    // sobrescribiera, ganaría la última procesada — un detalle interno de la ingesta.
    // Reclasificar es editar el producto, no recargar el libro.
    const r = resolver();
    const id = await r.resolve('Tortrix Original', 'snacks');
    await r.resolve('Tortrix Original', 'abarrotes');
    const [fila] = await owner`select category from products where id = ${id!}`;
    expect(fila!.category).toBe('snacks');
  });

  test('un producto creado sin categoría la recibe cuando una fila posterior sí la trae', async () => {
    // Es la otra mitad de lo anterior: no pisar lo que ya hay no puede significar dejar el
    // producto sin clasificar para siempre porque la primera fila que lo nombró venía
    // incompleta. Y funciona también cuando el producto ya está en el caché del
    // resolvedor, que es el camino que recorren las cientos de filas siguientes.
    const r = resolver();
    const id = await r.resolve('Harina Ideal 5lb');
    const [antes] = await owner`select category from products where id = ${id!}`;
    expect(antes!.category).toBeNull();

    await r.resolve('HARINA IDEAL 5LB', 'abarrotes');
    const [despues] = await owner`select category from products where id = ${id!}`;
    expect(despues!.category).toBe('abarrotes');
  });

  test('dos empresas pueden tener el mismo producto sin mezclarse', async () => {
    const otra = randomUUID();
    await owner`
      insert into companies (id, workos_org_id, name, industry, base_currency, locale)
      values (${otra}, ${'org_' + otra}, ${'Otra ' + otra}, 'retail', 'GTQ', 'es')
    `;
    const mio = await resolver().resolve('Producto Compartido');
    const suyo = await new ProductResolver(drizzle(owner, { schema }), otra).resolve(
      'Producto Compartido',
    );
    expect(suyo).not.toBe(mio!);
  });
});
