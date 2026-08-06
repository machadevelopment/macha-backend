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
 *
 * LA CATEGORÍA SE RELLENA UNA VEZ Y NO SE PISA. La familia comercial llega por fila, así
 * que el mismo producto puede venir con categoría en unas filas y sin ella en otras — muy
 * comúnmente el archivo la trae solo en la hoja de ventas y no en la de compras. Se
 * escribe cuando la fila del producto todavía la tiene en NULL, y a partir de ahí se deja
 * quieta. La alternativa —que cada fila sobrescriba— haría que la categoría final del
 * producto dependiera del orden en que se procesaron las filas del Excel, que es un
 * detalle interno: dos cargas del mismo archivo podrían dejar categorías distintas.
 * Reclasificar a mano se resuelve editando el producto, no recargando el libro.
 */
export class ProductResolver {
  /** nombre normalizado -> { id, tieneCategoria } */
  private readonly cache = new Map<string, { id: string; tieneCategoria: boolean }>();

  constructor(
    private readonly db: DB,
    private readonly companyId: string,
  ) {}

  async resolve(
    nombre: string | null | undefined,
    categoria?: string | null,
  ): Promise<string | null> {
    const limpio = nombre?.trim();
    if (!limpio) return null;

    const categoriaLimpia = categoria?.trim() || null;
    const clave = limpio.toLowerCase();

    const enCache = this.cache.get(clave);
    if (enCache) {
      await this.completarCategoria(enCache, categoriaLimpia);
      return enCache.id;
    }

    const [existente] = await this.db
      .select({ id: products.id, category: products.category })
      .from(products)
      .where(
        and(eq(products.companyId, this.companyId), rawSql`lower(${products.name}) = ${clave}`),
      )
      .limit(1);

    if (existente) {
      const entrada = { id: existente.id, tieneCategoria: existente.category !== null };
      this.cache.set(clave, entrada);
      await this.completarCategoria(entrada, categoriaLimpia);
      return entrada.id;
    }

    const [creado] = await this.db
      .insert(products)
      .values({ companyId: this.companyId, name: limpio, category: categoriaLimpia })
      .returning({ id: products.id });

    // `creado` siempre viene: no hay ON CONFLICT porque el UNIQUE es sobre
    // lower(name) y ya se comprobó arriba dentro de la misma transacción.
    this.cache.set(clave, { id: creado!.id, tieneCategoria: categoriaLimpia !== null });
    return creado!.id;
  }

  /** Escribe la categoría solo si el producto no tenía una. Ver la nota de la clase. */
  private async completarCategoria(
    entrada: { id: string; tieneCategoria: boolean },
    categoria: string | null,
  ): Promise<void> {
    if (entrada.tieneCategoria || categoria === null) return;
    await this.db
      .update(products)
      .set({ category: categoria, updatedAt: new Date() })
      .where(and(eq(products.companyId, this.companyId), eq(products.id, entrada.id)));
    entrada.tieneCategoria = true;
  }
}
