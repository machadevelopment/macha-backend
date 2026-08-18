import { and, eq, sql as rawSql } from 'drizzle-orm';
import type { DB } from '@/db/client';
import { stores } from '@/db/schema';

/**
 * Resuelve el nombre de una tienda a su fila en la dimensión `stores`, creándola la
 * primera vez que aparece.
 *
 * ═══ POR QUÉ NO EXISTÍA (CU-868kt8kk9) ═══
 *
 * Macha reportó que la carga "no lee las tiendas" y que el asesor responde que no tiene
 * esa información aunque el archivo sí la traiga. Verificado contra producción, y el
 * escenario 1 del ticket era el correcto — pero por una razón más de fondo que "el
 * clasificador no la reconoce":
 *
 * ```
 * stores:                     0 filas
 * transactions.store_id:      0 de 12 558
 * products:                 675 filas   ← la misma mecánica, funcionando
 * ```
 *
 * La tabla `stores` existe desde el data model y `transactions.store_id` la referencia
 * desde siempre. Lo que faltaba era todo el camino intermedio: **`ColumnMap` no tenía
 * campo de tienda**, así que el modelo no podía mapearla ni aunque la viera, `row-assembly`
 * no la podía armar y la promoción no tenía qué resolver. La columna del Excel se leía y
 * se tiraba en cada carga.
 *
 * Esta clase es el gemelo de `ProductResolver` y comparte sus tres decisiones, por las
 * mismas razones:
 *
 *   · **Caché por promoción.** Un libro trae cientos de filas de la misma tienda; sin el
 *     mapa, cada una haría un SELECT y un posible INSERT dentro de la transacción más
 *     caliente de la ingesta.
 *   · **Se compara en minúsculas.** El mismo local aparece como "TDA-001", "Tda-001" y
 *     "tda-001" en el mismo archivo. Sin normalizar, el ranking mostraría tres tiendas
 *     donde hay una y ninguna sería la que más vendió — que es justo la pregunta del
 *     ticket. Se guarda la capitalización de la primera aparición, que es la que el dueño
 *     reconoce, pero se busca normalizado.
 *   · **No se inventa tienda cuando viene `null`.** Una venta sin tienda identificable
 *     queda con `store_id` nulo, que es la verdad. Rellenarla con "Sin tienda" crearía una
 *     sucursal fantasma compitiendo en el ranking.
 *
 * Lo que NO comparte: `stores` no tiene categoría que completar, así que no hay
 * equivalente de `completarCategoria`. La tabla tiene `external_ref` para el código del
 * sistema del cliente, pero hoy nada lo puebla — el archivo trae un solo valor por fila y
 * no hay forma de saber si es el nombre o el código sin preguntarle al usuario.
 */
export class StoreResolver {
  /** nombre normalizado -> id */
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
      .select({ id: stores.id })
      .from(stores)
      .where(and(eq(stores.companyId, this.companyId), rawSql`lower(${stores.name}) = ${clave}`))
      .limit(1);

    if (existente) {
      this.cache.set(clave, existente.id);
      return existente.id;
    }

    const [creado] = await this.db
      .insert(stores)
      .values({ companyId: this.companyId, name: limpio })
      .returning({ id: stores.id });

    // Sin ON CONFLICT: el UNIQUE es sobre `(company_id, lower(name))` —migración 0004— y
    // ya se comprobó arriba dentro de la misma transacción.
    this.cache.set(clave, creado!.id);
    return creado!.id;
  }
}
