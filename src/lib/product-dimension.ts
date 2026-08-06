import { and, eq, sql as rawSql } from 'drizzle-orm';
import type { DB } from '@/db/client';
import { products } from '@/db/schema';

/**
 * Resuelve el nombre de un producto a su fila en la dimensión `products`, creándola la
 * primera vez que aparece.
 *
 * POR QUÉ UN CACHÉ POR PROMOCIÓN. Un libro puede traer cientos de filas del mismo
 * producto; sin el mapa, cada una haría un SELECT y un posible INSERT. La promoción ya
 * corre dentro de una sola transacción y es el punto más caliente de la ingesta.
 *
 * POR QUÉ SE COMPARA EN MINÚSCULAS. La IA extrae el nombre tal como viene en la celda, y
 * el mismo producto aparece como "Café Antigua", "CAFÉ ANTIGUA" y "café antigua" en el
 * mismo archivo. Sin normalizar, el dashboard mostraría tres productos donde hay uno y
 * ninguno sería el más vendido. Se guarda el nombre con la capitalización de la primera
 * aparición —es la que el dueño reconoce— pero se busca normalizado.
 *
 * NO se inventa producto cuando la IA devuelve `null`: una transacción sin producto
 * identificable queda con `product_id` nulo, que es la verdad. Rellenarlo con
 * "Sin categoría" crearía un producto fantasma que competiría en el ranking.
 */
export class ProductResolver {
  private readonly cache = new Map<string, string>();

  constructor(
    private readonly db: DB,
    private readonly companyId: string,
  ) {}

  async resolve(nombre: string | null | undefined): Promise<string | null> {
    const limpio = nombre?.trim();
    if (!limpio) return null;

    const clave = limpio.toLowerCase();
    const enCache = this.cache.get(clave);
    if (enCache) return enCache;

    const [existente] = await this.db
      .select({ id: products.id })
      .from(products)
      .where(
        and(eq(products.companyId, this.companyId), rawSql`lower(${products.name}) = ${clave}`),
      )
      .limit(1);

    if (existente) {
      this.cache.set(clave, existente.id);
      return existente.id;
    }

    const [creado] = await this.db
      .insert(products)
      .values({ companyId: this.companyId, name: limpio })
      .returning({ id: products.id });

    // `creado` siempre viene: no hay ON CONFLICT porque el UNIQUE es sobre
    // lower(name) y ya se comprobó arriba dentro de la misma transacción.
    this.cache.set(clave, creado!.id);
    return creado!.id;
  }
}
