import { eq, and, inArray, isNull, sql as rawSql } from 'drizzle-orm';
import type { DB } from '@/db/client';
import {
  stagingRows,
  documents,
  transactions,
  invoices,
  bills,
  companies,
  inventoryItems,
  inventoryMovements,
} from '@/db/schema';
import { findFxRate, missingFxRateMessage, type Currency } from '@/lib/fx';
import { ProductResolver } from '@/lib/product-dimension';
import { StoreResolver } from '@/lib/store-dimension';
import { enqueue, QUEUES } from '@/queue';

export type PromotionResult =
  | {
      promoted: true;
      transactionCount: number;
      invoiceCount: number;
      billCount: number;
      /**
       * Migración 0020: cuántas filas del documento quedaron esperando revisión de Macha
       * DESPUÉS de esta promoción. Con promoción parcial `promoted: true` y
       * `pendingCount > 0` conviven — es el estado normal ahora, no una contradicción: el
       * archivo entró a producción con lo que se pudo y estas filas siguen retenidas.
       */
      pendingCount: number;
    }
  | {
      promoted: false;
      /**
       * `already_promoted`: otra ejecución de este mismo documento ganó la carrera y ya
       * insertó sus filas. No es un error — es la salida correcta cuando el worker corre
       * dos veces a la vez (ver la nota de la reserva en `promoteDocument`). El worker lo
       * trata como "no hay nada que hacer aquí" y NO toca el estado del documento, que ya
       * dejó bien la ejecución ganadora.
       */
      reason: 'pending_rows' | 'no_rows' | 'all_rejected' | 'already_promoted';
      /**
       * CU-868kn5hqu: cuántas filas están frenando la promoción. Antes esto no salía de
       * aquí, así que `documents.flagged_count` quedaba en NULL y el cliente veía su
       * dashboard en cero sin forma de saber que su carga estaba esperando revisión —
       * ni cuánto faltaba. Un libro real dejó 542 filas marcadas y el producto se leía
       * como roto.
       */
      pendingCount: number;
    };

type TransactionPayload = {
  type: 'revenue' | 'cogs' | 'opex' | 'other';
  category: string;
  date: string;
  description?: string;
  originalAmount: number;
  originalCurrency: 'GTQ' | 'USD';
  /** Nombre del producto cuando la fila lo trae; `null` si no aplica. */
  product?: string | null;
  /** Unidades de la fila; `null` cuando la fila no habla de unidades. */
  quantity?: number | null;
  /** Familia comercial del producto; distinta de `category`, que clasifica el movimiento. */
  productCategory?: string | null;
  /**
   * CU-868kt8kk9: la tienda/sucursal donde ocurrió la fila. `null` cuando el archivo no
   * trae esa columna, que es la mayoría de los libros de un solo local.
   */
  store?: string | null;
};

type InvoiceLikePayload = {
  counterparty: string;
  issueDate: string;
  dueDate?: string;
  originalAmount: number;
  originalCurrency: 'GTQ' | 'USD';
};

/** originalAmount * fxRate -> amountBase, como string (columna numeric — nunca
 * float, data model §3/CLAUDE.md). Extraída como función pura para poder probar la
 * conversión de moneda sin una fila real de staging_rows/fx_rates. */
export function computeAmountBase(originalAmount: number, fxRate: number): string {
  return String(originalAmount * fxRate);
}

/**
 * Unidades de la fila -> columna `numeric` (string) o NULL.
 *
 * Todo lo que no sea un número positivo y finito se convierte en NULL en vez de tumbar la
 * promoción. La cantidad es un dato de enriquecimiento: si la IA devuelve 0, un negativo o
 * basura, la respuesta correcta es "no sabemos cuántas unidades", no perder el movimiento
 * financiero —que sí está bien— por un campo accesorio. El CHECK
 * `transactions_quantity_chk` de la migración 0019 rechazaría esos valores de todas
 * formas, y ahí el fallo sería de la carga entera: la promoción es atómica, una fila mala
 * arrastra el documento completo.
 *
 * Se exporta para poder probar esa frontera sin montar una promoción con Postgres.
 */
export function normalizeQuantity(quantity: number | null | undefined): string | null {
  if (typeof quantity !== 'number' || !Number.isFinite(quantity) || quantity <= 0) return null;
  return String(quantity);
}

/**
 * Resuelve la tasa vigente o falla con un mensaje accionable.
 *
 * CU-868kjc6h1 criterio 3: el error que llega a `documents.error_reason` —lo que el
 * staff ve en el monitoreo de uploads— decía `No fx_rate for company <uuid>:
 * USD->GTQ on or before 2026-07-01`. Exacto y sin salida: no decía qué hacer. Ahora el
 * texto viene de `missingFxRateMessage` y nombra la acción concreta. La lógica de
 * lookup vive en `lib/fx.ts` porque la ingesta la necesita antes, para marcar la fila
 * en vez de tumbar la carga entera.
 */
async function resolveFxRate(
  db: DB,
  companyId: string,
  quoteCurrency: Currency,
  onOrBefore: string,
): Promise<{ rate: number; effectiveDate: string }> {
  const [company] = await db
    .select({ baseCurrency: companies.baseCurrency })
    .from(companies)
    .where(eq(companies.id, companyId));
  const base = company!.baseCurrency;

  const fx = await findFxRate(db, companyId, base, quoteCurrency, onOrBefore);
  if (!fx) {
    throw new Error(missingFxRateMessage({ quote: quoteCurrency, base, onOrBefore }));
  }
  return fx;
}

/**
 * `staging_rows` -> `transactions`/`invoices`/`bills`.
 *
 * PROMOCIÓN PARCIAL (decisión de Keneth, 2026-08-07 — migración 0020). Promueve lo que se
 * puede y retiene SOLO lo marcado. Antes era todo-o-nada por documento: una fila dudosa
 * entre mil dejaba fuera de producción a las otras 999 hasta que un humano de Macha entrara
 * al backoffice, así que la revisión interna —pensada como excepción— era el camino
 * obligatorio de todo upload. Medido el 2026-08-06: cero filas en producción con 3.195 en
 * staging, y de 414 filas marcadas de un archivo real 313 lo estaban por una tasa de cambio
 * que faltaba de nuestro lado.
 *
 * LA ATOMICIDAD SQL NO SE TOCA, y no hay que confundirla con la regla anterior: el `db` que
 * recibe DEBE venir ya dentro de una transacción (el worker usa `withCompanyScope`, que
 * envuelve el job en begin/commit/rollback), así que un throw acá revierte cada INSERT. Lo
 * que cambió es el CONJUNTO que entra en esa transacción: antes "todas las filas del
 * documento o ninguna", ahora "todas las promovibles o ninguna".
 *
 * IDEMPOTENCIA POR FILA, NO POR DOCUMENTO. El cerrojo era
 * `UPDATE documents ... WHERE status <> 'promoted'`, y con promoción parcial ese mismo
 * cerrojo impediría la segunda pasada legítima (la de las filas que staff resuelva después).
 * Ahora se reclaman las FILAS: el `UPDATE staging_rows SET promoted_at = now() WHERE
 * promoted_at IS NULL RETURNING` toma el lock de cada fila, así que dos ejecuciones
 * simultáneas no pueden reclamar la misma y la segunda ve cero filas que reclamar. Es la
 * misma garantía que daba el cerrojo de documento —verificada en producción el 2026-08-06,
 * cuando pg-boss venció un job y encoló un segundo intento encima del primero— pero al grano
 * correcto.
 *
 * Reclamar ANTES de insertar es deliberado: si el INSERT lanza (p. ej. falta la tasa de
 * cambio), la transacción entera se revierte y con ella el sello de `promoted_at`, así que la
 * fila vuelve a estar disponible para el próximo intento. No se puede "perder" una fila por
 * haberla marcado antes de tiempo.
 */
export async function promoteDocument(
  db: DB,
  companyId: string,
  documentId: string,
): Promise<PromotionResult> {
  // Foto de TODAS las filas del documento, promovidas o no. Hace falta completa para poder
  // distinguir los desenlaces: un documento sin filas (`no_rows`) no es lo mismo que uno
  // cuyas filas ya se promovieron todas (`already_promoted`).
  const todas = await db
    .select({
      id: stagingRows.id,
      reviewStatus: stagingRows.reviewStatus,
      promotedAt: stagingRows.promotedAt,
    })
    .from(stagingRows)
    .where(and(eq(stagingRows.companyId, companyId), eq(stagingRows.documentId, documentId)));

  if (todas.length === 0) {
    return { promoted: false, reason: 'no_rows', pendingCount: 0 };
  }

  /**
   * Qué entra y qué se queda:
   *
   *  · `clean`/`approved` sin promover  -> entra ahora.
   *  · `pending`                        -> se queda esperando revisión de Macha. NO bloquea.
   *  · `rejected`                       -> nunca entra. Un humano dijo que esa fila no sirve,
   *                                        y el bucle de inserción no mira `review_status`,
   *                                        así que excluirla acá es lo único que lo impide.
   *  · ya promovida (`promoted_at`)     -> no se vuelve a insertar.
   */
  const pendientes = todas.filter((r) => r.reviewStatus === 'pending').length;
  const promovibles = todas.filter(
    (r) => r.promotedAt === null && (r.reviewStatus === 'clean' || r.reviewStatus === 'approved'),
  );

  if (promovibles.length === 0) {
    // Nada nuevo que insertar. Los tres desenlaces son distintos para quien llama, porque
    // cada uno le dice algo distinto al cliente.
    if (pendientes > 0) {
      // Todo lo que traía el archivo está marcado: esto SÍ es un archivo trabado, el caso
      // que la revisión interna existe para atender.
      return { promoted: false, reason: 'pending_rows', pendingCount: pendientes };
    }
    if (todas.some((r) => r.promotedAt !== null)) {
      return { promoted: false, reason: 'already_promoted', pendingCount: 0 };
    }
    // Quedan filas, ninguna pendiente, ninguna promovida: staff las rechazó todas. Es un
    // desenlace distinto de `no_rows` (la IA no extrajo nada) y no debe compartir su
    // mensaje — acá el archivo sí traía filas y un humano decidió que ninguna servía.
    return { promoted: false, reason: 'all_rejected', pendingCount: 0 };
  }

  // El reclamo. Solo las filas que este UPDATE devuelve son nuestras para insertar; si otra
  // ejecución concurrente ya reclamó alguna, no vuelve en `reclamadas`.
  const ids = promovibles.map((r) => r.id);
  const reclamadas = await db
    .update(stagingRows)
    .set({ promotedAt: new Date() })
    .where(
      and(
        eq(stagingRows.companyId, companyId),
        eq(stagingRows.documentId, documentId),
        inArray(stagingRows.id, ids),
        isNull(stagingRows.promotedAt),
      ),
    )
    .returning({
      id: stagingRows.id,
      targetEntity: stagingRows.targetEntity,
      payload: stagingRows.payload,
    });

  if (reclamadas.length === 0) {
    // Otra ejecución ganó la carrera por todas.
    return { promoted: false, reason: 'already_promoted', pendingCount: pendientes };
  }

  let transactionCount = 0;
  let invoiceCount = 0;
  let billCount = 0;

  // Un resolvedor por promoción: su caché evita repetir consultas para el mismo
  // producto, que en un libro de ventas se repite en cientos de filas.
  const productos = new ProductResolver(db, companyId);
  // CU-868kt8kk9: lo mismo para la TIENDA. Un libro de una cadena repite la misma sucursal
  // en casi todas sus filas, así que sin caché sería un SELECT por venta.
  const tiendas = new StoreResolver(db, companyId);

  for (const row of reclamadas) {
    if (row.targetEntity === 'transaction') {
      const p = row.payload as unknown as TransactionPayload;
      const fx = await resolveFxRate(db, companyId, p.originalCurrency, p.date);
      const productId = await productos.resolve(p.product, p.productCategory);
      const storeId = await tiendas.resolve(p.store);
      await db.insert(transactions).values({
        companyId,
        documentId,
        productId,
        storeId,
        quantity: normalizeQuantity(p.quantity),
        date: p.date,
        type: p.type,
        category: p.category,
        description: p.description ?? null,
        originalAmount: String(p.originalAmount),
        originalCurrency: p.originalCurrency,
        amountBase: computeAmountBase(p.originalAmount, fx.rate),
        fxRate: String(fx.rate),
        fxRateDate: fx.effectiveDate,
      });
      transactionCount++;
    } else {
      const p = row.payload as unknown as InvoiceLikePayload;
      const fx = await resolveFxRate(db, companyId, p.originalCurrency, p.issueDate);
      const values = {
        companyId,
        documentId,
        counterparty: p.counterparty,
        issueDate: p.issueDate,
        dueDate: p.dueDate ?? null,
        originalAmount: String(p.originalAmount),
        originalCurrency: p.originalCurrency,
        amountBase: computeAmountBase(p.originalAmount, fx.rate),
        fxRate: String(fx.rate),
        fxRateDate: fx.effectiveDate,
        status: 'open' as const,
      };
      if (row.targetEntity === 'invoice') {
        await db.insert(invoices).values(values);
        invoiceCount++;
      } else {
        await db.insert(bills).values(values);
        billCount++;
      }
    }
  }

  /**
   * `row_count` es ACUMULADO, no el de esta pasada: en la segunda promoción de un mismo
   * documento (la de las filas que staff resolvió) sobrescribirlo con `reclamadas.length`
   * diría que el archivo aportó 3 filas cuando aportó 1.003.
   *
   * `flagged_count` queda en las que siguen pendientes, no en 0. Es el número con el que el
   * cliente entiende por qué sus totales no cuadran con su Excel, y con promoción parcial un
   * documento puede estar `promoted` Y tener filas esperando revisión — el estado normal
   * ahora, no una excepción.
   */
  const yaPromovidas = todas.filter((r) => r.promotedAt !== null).length;

  await db
    .update(documents)
    .set({
      status: 'promoted',
      promotedAt: new Date(),
      rowCount: yaPromovidas + reclamadas.length,
      flaggedCount: pendientes,
    })
    .where(eq(documents.id, documentId));

  return {
    promoted: true,
    transactionCount,
    invoiceCount,
    billCount,
    pendingCount: pendientes,
  };
}

/**
 * Revert (CU-868kfva9z): soft-delete every business row created from this document,
 * preserving the audit trail (data model §16). `documents` keeps its history —
 * status flips to 'reverted', nothing is deleted.
 */
/**
 * Deshace el inventario que dejó una carga, con movimientos COMPENSATORIOS.
 *
 * ═══ POR QUÉ COMPENSAR Y NO BORRAR ═══
 *
 * `inventory_movements` es un ledger append-only (CLAUDE.md) y el rol de la app no tiene
 * DELETE sobre él. Pero además sería incorrecto aunque se pudiera: el movimiento OCURRIÓ —
 * ese conteo se aplicó y durante un tiempo fue el saldo real de la empresa. Borrarlo dejaría
 * un historial que no explica por qué el número cambió. La corrección es una fila que dice
 * "esto se deshizo porque se revirtió la carga X", que es exactamente lo que un auditor
 * necesita leer.
 *
 * ═══ EL HUECO QUE ESTO TAPA ═══
 *
 * Desde que el Excel puede poblar el inventario (CU-868krkfrh), revertir una carga devolvía
 * la contabilidad pero **dejaba el inventario con los números del archivo malo, para siempre
 * y sin forma de deshacerlo desde la interfaz**. Lo introdujo el propio import de inventario y
 * se corrige antes de que llegue a un cliente.
 *
 * ═══ QUÉ NO TOCA ═══
 *
 * Los movimientos con `document_id IS NULL` — los que alguien registró A MANO. Revertir una
 * carga no puede deshacer un conteo físico que una persona hizo después: ese movimiento no
 * salió de este archivo y su verdad no depende de él.
 *
 * ═══ LOS ARTÍCULOS SE QUEDAN, EN CERO ═══
 *
 * Un SKU que nació de la carga revertida queda con existencia 0, no se da de baja. Es lo
 * honesto —"ya no creemos que tengas ninguno"— y es reversible: el cliente puede darlo de baja
 * si sobra. Borrarlo destruiría cualquier edición manual que se le haya hecho desde entonces.
 *
 * ═══ SE COMPENSA EL NETO, Y ESO LO HACE IDEMPOTENTE ═══
 *
 * Se suma el efecto de TODOS los movimientos de esta carga sobre cada artículo y se escribe
 * UNA fila que lo anula. No una compensación por movimiento.
 *
 * La diferencia no es de estilo. Las filas compensatorias llevan el mismo `document_id` que
 * las que anulan —tienen que llevarlo, es de dónde salieron—, así que una versión que
 * compensara movimiento a movimiento, al correr dos veces, compensaría también sus propias
 * compensaciones y dejaría el saldo corrido. Sumando el neto eso no puede pasar: después de
 * la primera pasada el neto de esta carga es cero y la segunda no escribe nada.
 *
 * Hoy la ruta ya impide revertir dos veces (exige `promoted`), pero esta función es
 * exportable y la corrección de un saldo no debe depender de que el llamador se acuerde.
 */
async function compensarInventario(
  db: DB,
  companyId: string,
  documentId: string,
  now: Date,
): Promise<void> {
  // El signo con el que cada movimiento afectó al saldo: `out` resta, el resto suma. Se agrega
  // en SQL por artículo para no traer miles de filas a JS solo para sumarlas.
  const netos = await db
    .select({
      itemId: inventoryMovements.itemId,
      neto: rawSql<string>`sum(
        case when ${inventoryMovements.movementType} = 'out'
          then -${inventoryMovements.quantity}
          else ${inventoryMovements.quantity}
        end
      )`,
    })
    .from(inventoryMovements)
    .where(
      and(
        eq(inventoryMovements.companyId, companyId),
        eq(inventoryMovements.documentId, documentId),
      ),
    )
    .groupBy(inventoryMovements.itemId);

  for (const fila of netos) {
    const neto = Number(fila.neto);
    // Neto cero = o esta carga no movió nada de este artículo, o ya se compensó. En los dos
    // casos no hay nada que escribir, y es lo que hace que revertir dos veces sea inofensivo.
    if (neto === 0) continue;

    /*
     * La aritmética va en SQL sobre la fila bloqueada, igual que `recordMovement`: leer el
     * saldo en JS para reescribirlo perdería la escritura de cualquier movimiento concurrente.
     */
    const [actualizado] = await db
      .update(inventoryItems)
      .set({
        quantityOnHand: rawSql`${inventoryItems.quantityOnHand} - ${String(neto)}`,
        updatedAt: now,
      })
      .where(and(eq(inventoryItems.companyId, companyId), eq(inventoryItems.id, fila.itemId)))
      .returning({ quantityOnHand: inventoryItems.quantityOnHand });

    // El artículo pudo darse de baja entre medias; sin fila que actualizar no hay saldo que
    // registrar, y compensar un ledger contra un item inexistente sería inventar historia.
    if (!actualizado) continue;

    await db.insert(inventoryMovements).values({
      companyId,
      itemId: fila.itemId,
      // `adjustment` y no el tipo inverso: no entró ni salió mercadería, se corrigió el libro.
      movementType: 'adjustment',
      quantity: String(-neto),
      quantityAfter: actualizado.quantityOnHand,
      reason: 'Se revirtió la carga que originó este movimiento',
      documentId,
    });
  }

  /*
   * ═══════════════════════════════════════════════════════════════════════════════════════════
   * Y EL ARTÍCULO QUE SOLO EXISTÍA POR ESTA CARGA SE DA DE BAJA (2026-08-30)
   * ═══════════════════════════════════════════════════════════════════════════════════════════
   *
   * Dejar la existencia en cero NO es revertir. Reporte de Keneth: *"he subido 4 archivos, les
   * di revert y toda la data del dashboard se limpia pero el inventario sigue apareciendo lo
   * del primer excel"*.
   *
   * El síntoma señala la causa con precisión, y es más específica de lo que parece: sigue
   * apareciendo lo del PRIMERO porque el importador trata la cantidad como un CONTEO —la
   * primera carga CREA el artículo con su nombre, SKU y costo; las siguientes solo ajustan la
   * cantidad del mismo SKU—. Así que los artículos en pantalla son, por construcción, los que
   * creó la primera carga.
   *
   * La compensación de arriba hacía bien su parte (la existencia queda en cero) pero el listado
   * filtra por `deleted_at` y **nunca por cantidad**. Para el dueño eso no es un inventario
   * vacío: es su inventario mostrando cosas que ya revirtió, al lado de un dashboard que sí
   * quedó limpio. Medido contra Postgres real: 1 artículo donde debía haber 0.
   *
   * ═══ EL CRITERIO NO ES "LA CREÓ ESTA CARGA", Y ESA DISTINCIÓN ES TODO ═══
   *
   * `inventory_items` no guarda qué documento lo creó —solo los movimientos llevan
   * `document_id`— pero aunque lo guardara, ese criterio sería el equivocado: un artículo que
   * la carga 1 creó y que alguien ajustó A MANO después no debe desaparecer porque se revierta
   * la carga 1. Ese conteo manual es trabajo de una persona y borrarlo sería peor que el bug.
   *
   * El criterio correcto es **que no quede nadie más sosteniéndolo**: se da de baja solo si su
   * existencia quedó en cero Y **todos** sus movimientos vienen de cargas ya revertidas o
   * canceladas. Un movimiento manual tiene `document_id` NULL, así que su sola presencia salva
   * al artículo — que es exactamente la garantía que `recordMovement` ya prometía en su
   * comentario ("sin tocar los conteos que alguien registró a mano después") y que hasta hoy
   * nada hacía cumplir.
   *
   * El documento que se está revirtiendo AHORA cuenta como revertido aunque su fila todavía
   * diga `promoted`: `deshacerFilas` sella el estado unas líneas más abajo, y esperar a eso
   * obligaría a partir la transacción.
   *
   * Es un soft-delete, igual que el resto del revert: si la carga se vuelve a subir, el
   * artículo se crea de nuevo con su historia limpia.
   */
  /*
   * Los artículos a evaluar son los que ESTA carga tocó… y también los que ESTA carga CREÓ sin
   * moverlos.
   *
   * Un artículo importado con existencia CERO no tiene ni un movimiento —`recordMovement`
   * rechaza cantidad 0, con razón— así que no aparece en `netos` y la primera versión de este
   * bloque no lo veía. Medido en producción: 240 vehículos que ningún revert alcanzaba y que
   * el script de limpieza además PROTEGÍA, porque «sin movimientos» es justo su señal de que lo
   * dio de alta una persona. `inventory_items.document_id` (migración 0038) es lo que cierra
   * ese hueco.
   */
  const creadosPorLaCarga = await db
    .select({ id: inventoryItems.id })
    .from(inventoryItems)
    .where(
      and(
        eq(inventoryItems.companyId, companyId),
        eq(inventoryItems.documentId, documentId),
        isNull(inventoryItems.deletedAt),
      ),
    );

  const tocados = [...new Set([...netos.map((f) => f.itemId), ...creadosPorLaCarga.map((c) => c.id)])]; // prettier-ignore
  if (tocados.length === 0) return;

  const huerfanos = await db
    .select({ id: inventoryItems.id })
    .from(inventoryItems)
    .where(
      and(
        eq(inventoryItems.companyId, companyId),
        inArray(inventoryItems.id, tocados),
        isNull(inventoryItems.deletedAt),
        rawSql`${inventoryItems.quantityOnHand} = 0`,
        // Ni un solo movimiento que NO venga de una carga revertida: ni manual (document_id
        // NULL), ni de otra carga que siga viva.
        rawSql`not exists (
          select 1 from ${inventoryMovements} m
           where m.company_id = ${companyId}
             and m.item_id = ${inventoryItems.id}
             and (
               m.document_id is null
               or (
                 m.document_id <> ${documentId}
                 and not exists (
                   select 1 from ${documents} d
                    where d.id = m.document_id
                      and d.status in ('reverted', 'cancelled')
                 )
               )
             )
        )`,
      ),
    );

  if (huerfanos.length > 0) {
    await db
      .update(inventoryItems)
      .set({ deletedAt: now, updatedAt: now })
      .where(
        and(
          eq(inventoryItems.companyId, companyId),
          inArray(
            inventoryItems.id,
            huerfanos.map((h) => h.id),
          ),
        ),
      );
  }
}

/**
 * Deshace las filas de una carga: soft-delete en los tres ledgers + compensación de
 * inventario, y deja el documento en `estadoFinal`.
 *
 * ═══ POR QUÉ ESTO SE COMPARTE ENTRE REVERTIR Y CANCELAR (CU-868kttzb1) ═══
 *
 * `revert` y `cancel` son la misma operación sobre distinto momento: deshacer una carga que
 * ya terminó, y deshacer una que va a medias. Hasta este ticket solo `revert` deshacía
 * filas, y `cancel` se limitaba a cambiar el estado — dejando VIVAS las que la promoción
 * parcial (migración 0020) ya había escrito.
 *
 * Eso rompía la deduplicación por un camino que no se ve: `findSeenFingerprints` excluye
 * `cancelled` de los estados con datos vivos, con el argumento de que "ninguno deja filas
 * vivas en producción". Era cierto para `unsupported`, y falso para `cancelled` desde que la
 * promoción es incremental. Resultado: las filas quedaban en el ledger pero sus huellas
 * dejaban de bloquear, así que resubir el MISMO archivo las metía otra vez.
 *
 * Reproducido con los dos .xlsx del reporte, que resultaron ser IDÉNTICOS byte a byte —
 * mismo MD5. O sea que no era un archivo distinto ni un mapa de columnas cambiado: era el
 * estado `cancelled` mintiendo sobre si tenía datos.
 *
 * Con el soft-delete acá, la afirmación de `row-fingerprint.ts` vuelve a ser verdad y no
 * hace falta tocarla.
 */
async function deshacerFilas(
  db: DB,
  companyId: string,
  documentId: string,
  estadoFinal: 'reverted' | 'cancelled',
): Promise<void> {
  const now = new Date();
  const match = and(eq(transactions.companyId, companyId), eq(transactions.documentId, documentId));

  /*
   * ═══════════════════════════════════════════════════════════════════════════════════════════
   * SE RESERVA EL DOCUMENTO ANTES DE TOCAR NADA — DOS REVERTS A LA VEZ COMPENSAN DOS VECES
   * ═══════════════════════════════════════════════════════════════════════════════════════════
   *
   * Medido en producción (2026-08-30): `Gym Supplements` tenía **2.460 artículos con existencia
   * −1**. Un inventario no puede ser negativo. El rastro lo decía entero:
   *
   *     in          +1  (Existencia inicial)
   *     adjustment  −1  (Se revirtió la carga que originó este movimiento)   18:26:02
   *     adjustment  −1  (Se revirtió la carga que originó este movimiento)   18:26:12
   *
   * El MISMO documento, compensado dos veces, con diez segundos de diferencia.
   *
   * ═══ POR QUÉ LAS DEFENSAS QUE YA HABÍA NO ALCANZARON ═══
   *
   * Hay dos, y las dos son correctas por separado:
   *   · el endpoint sale temprano si el documento ya está `reverted`;
   *   · `compensarInventario` es idempotente — si el neto de la carga ya es cero, no escribe.
   *
   * Las dos leen un estado que la primera ejecución **todavía no había commiteado**. Con 2.460
   * artículos, esa transacción hace ~4.900 consultas secuenciales y tarda bastante más de diez
   * segundos; el segundo clic entró en el medio, leyó `promoted` y un neto de +1, y compensó
   * otra vez. Cuanto más grande el inventario del cliente, más ancha la ventana — y el arreglo
   * de hoy, que además da de baja artículos, la ensancha un poco más.
   *
   * `FOR UPDATE` sobre la fila del documento cierra la ventana en el único punto donde las dos
   * ejecuciones se cruzan: la segunda espera a que la primera COMMITEE, y entonces sí ve
   * `reverted` y un neto de cero. Es la misma reserva que `promoteDocument` ya usa para que dos
   * workers no promuevan la misma carga.
   *
   * Va PRIMERO, antes de compensar: reservar después de haber escrito no reserva nada.
   */
  await db
    .select({ id: documents.id })
    .from(documents)
    .where(eq(documents.id, documentId))
    .for('update');

  // El inventario PRIMERO: lee los movimientos de esta carga, y hacerlo antes de tocar nada
  // más deja la lectura sobre un estado que ninguna otra parte de esta función alteró.
  await compensarInventario(db, companyId, documentId, now);

  await db.update(transactions).set({ deletedAt: now }).where(match);
  await db
    .update(invoices)
    .set({ deletedAt: now })
    .where(and(eq(invoices.companyId, companyId), eq(invoices.documentId, documentId)));
  await db
    .update(bills)
    .set({ deletedAt: now })
    .where(and(eq(bills.companyId, companyId), eq(bills.documentId, documentId)));
  await db
    .update(documents)
    // `revertedAt` se sella también al cancelar: es la marca de CUÁNDO se deshicieron las
    // filas, y sin ella una carga cancelada a medias no tendría cómo decir que sus datos ya
    // no cuentan. El estado distingue quién lo pidió y en qué momento.
    .set({ status: estadoFinal, revertedAt: now })
    .where(eq(documents.id, documentId));
}

export async function revertDocument(db: DB, companyId: string, documentId: string): Promise<void> {
  await deshacerFilas(db, companyId, documentId, 'reverted');
}

/**
 * Cancelar una carga en curso deshace lo que alcanzó a promoverse — CU-868kttzb1.
 *
 * La promoción es PARCIAL e incremental desde la migración 0020: cuando alguien cancela, lo
 * limpio de los lotes ya procesados YA está en su dashboard. Dejarlo ahí es lo que duplicaba
 * los números al resubir el archivo.
 *
 * Se deshace en vez de conservarse porque es lo que el usuario cree que hizo: apretó
 * "cancelar" sobre una carga que no quería. Conservar la mitad de un archivo que alguien
 * decidió no cargar es un estado que nadie pidió y que además nadie ve — no hay pantalla que
 * diga "de esta carga cancelada entraron 300 filas".
 */
export async function cancelDocumentRows(
  db: DB,
  companyId: string,
  documentId: string,
): Promise<void> {
  await deshacerFilas(db, companyId, documentId, 'cancelled');
}

/**
 * Cierra el ciclo de la revisión interna: encola la promoción de la fila que se acaba de
 * resolver.
 *
 * NO ESPERA A QUE NO QUEDE NINGUNA PENDIENTE, y esa es la diferencia con la primera versión
 * de esta función. Con promoción parcial (migración 0020) cada fila aprobada entra por su
 * cuenta, así que hacer esperar a la última pendiente retrasaría sin motivo a las 400 ya
 * resueltas de un archivo de 414 — y si una sola fila nunca se resuelve, no entrarían nunca.
 *
 * Los estados que sí reciben filas nuevas son `promoted` (el normal ahora: el archivo ya
 * entró con lo limpio y le quedan filas retenidas) y `review` (el archivo entero venía
 * marcado y no se pudo promover nada). Se filtra por esos dos a propósito: sin el filtro,
 * resolver una fila vieja de un documento `reverted` o `failed` lo resucitaría a `promoted`,
 * reinsertando en producción datos que alguien había dado de baja.
 *
 * ═══ VIVE ACÁ Y NO EN EL MÓDULO ADMIN (2026-08-20) ═══
 *
 * Nació dentro de `/admin/staging-rows` porque la revisión interna era el único camino que
 * resolvía una fila. Ya no lo es: el cliente resuelve sus propios conceptos desde el flujo de
 * subida (decisión de Semi), y ese camino necesita cerrar el ciclo exactamente igual.
 *
 * Duplicarla sería peor que moverla: el filtro de estados de abajo es lo que evita resucitar
 * un documento `reverted` a `promoted`, y dos copias de esa regla se separan la primera vez que
 * alguien toca una sola.
 *
 * Se llama desde los caminos que RESUELVEN una fila (el `PATCH` de staff y la respuesta del
 * cliente), nunca desde uno que solo la reescribe. La
 * re-extracción (`POST /:id/reextract`) reescribe payload/confianza pero deja
 * `review_status` en `pending` a propósito: que Claude reconsidere no es que un humano
 * aprobó, y la fila todavía tiene que pasar por el `PATCH`.
 *
 * Es best-effort y no revienta la respuesta del `PATCH`: la revisión de la fila YA se
 * confirmó y auditó cuando llegamos acá. Si la cola está caída, lo correcto es que el
 * operador vea su cambio guardado —no un 500 que le haga pensar que no se guardó— y que la
 * fila quede pendiente de promover, que es recuperable. Se registra en consola para que el
 * fallo no sea invisible.
 */
export async function encolarPromocionDeLoResuelto(
  db: DB,
  companyId: string,
  documentId: string,
): Promise<void> {
  try {
    const [doc] = await db
      .select({ status: documents.status, confirmedAt: documents.confirmedAt })
      .from(documents)
      .where(eq(documents.id, documentId));
    /*
     * `awaiting_confirmation` entra acá (migración 0042): es el estado de una carga recién
     * procesada, y este es justamente el camino que corre cuando el cliente aprieta
     * "publicar". Sin incluirlo, el portón se cierra y no lo abre nadie — el cliente confirma
     * y su contabilidad no entra nunca.
     */
    const PROMOVIBLES = ['review', 'promoted', 'awaiting_confirmation'];
    if (!doc || !PROMOVIBLES.includes(doc.status)) return;

    /*
     * ═════════════════════════════════════════════════════════════════════════════════════════
     * EL PORTÓN: NADA ENTRA SIN QUE EL CLIENTE LO CONFIRME (migración 0042, 2026-09-01)
     * ═════════════════════════════════════════════════════════════════════════════════════════
     *
     * Hay EXACTAMENTE DOS caminos a la promoción y los dos quedan cerrados: el worker, que
     * llama a `promoteDocument` al terminar la ingesta, y esta función, que es la ÚNICA que
     * encola `document.promote` (verificado: ningún otro `enqueue(QUEUES.documentPromote)` en
     * todo `src/`). Cerrar solo uno dejaría media puerta abierta.
     *
     * El portón NO vive dentro de `promoteDocument` a propósito, aunque sería el punto único:
     * esa función es el mecanismo de promover y su contrato —"inserta lo promovible"— lo usan
     * el staff y la propia confirmación. Meterle una condición de PRODUCTO la volvería
     * imposible de llamar desde el camino que existe justamente para abrir el portón.
     *
     * Por qué existe: los siete fallos de ingesta de esta semana NO fueron filas dudosas.
     * Fueron decisiones sobre HOJAS, con alta confianza y equivocadas — una cartera de clientes
     * leída como ingresos, un consolidado contado dos veces, un presupuesto entrando como
     * dinero real. Ninguna la atrapaba una revisión por fila; todas se ven de un vistazo en un
     * resumen por hoja con su monto al lado.
     *
     * ⚠️ Reintroduce la forma que dejó 0 filas en producción antes de la 0020, y se asumió a
     * propósito. La diferencia es de quién es el trabajo: allá lo hacía staff de Macha y era
     * fila por fila; acá lo hace el dueño y son tres o cuatro decisiones sobre su archivo. La
     * mitigación no es aflojar el portón sino hacerlo imposible de no ver — correo con deep
     * link, banner, y la carga listada como "esperando tu confirmación".
     */
    if (doc.confirmedAt === null) return;

    await enqueue(QUEUES.documentPromote, { documentId, companyId });
  } catch (err) {
    console.error('[promotion] no se pudo encolar la promoción de lo resuelto:', documentId, err);
  }
}
