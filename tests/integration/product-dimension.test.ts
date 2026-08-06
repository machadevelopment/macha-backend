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
