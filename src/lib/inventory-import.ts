import { and, eq, isNull, sql as rawSql } from 'drizzle-orm';
import type { DB } from '@/db/client';
import { inventoryItems } from '@/db/schema';
import { normalizeHeader } from './sheet-classifier';
import { createItem, recordMovement, InventoryError } from '@/modules/inventory/service';
import type { Currency } from './fx';

/**
 * Importar el inventario del cliente desde su Excel (CU-868krkfrh · CU-868krmrcj fase B′).
 *
 * ═══ EL BUG QUE CIERRA ═══
 *
 * Macha reportó "Inventario no carga datos con ningún archivo", y el diagnóstico fue
 * categórico: NADA fuera de `modules/inventory/` escribía `inventory_items`, y la hoja de
 * inventario ni siquiera llegaba al modelo — el pre-filtro la clasifica como catálogo y la
 * descarta. En producción, en cada carga de cada una de las tres empresas:
 *
 *   hoja "Inventario" descartada por encabezados (catálogo, no movimientos): 211 filas
 *
 * El cliente SÍ trae su inventario. Se tiraba entero.
 *
 * ═══ SIN IA, Y ES UNA DECISIÓN, NO UN ATAJO ═══
 *
 * Una hoja de existencias tiene encabezados predecibles: SKU, nombre, cantidad, costo. El
 * pre-filtro existe justamente para que los catálogos no cuesten tokens, así que mandarla al
 * modelo desharía lo que ese filtro vino a lograr. Si el mapeo por encabezados no alcanza, la
 * respuesta correcta es no importar esa hoja y decirlo — no pagar por adivinar.
 *
 * ═══ LA CANTIDAD DEL ARCHIVO ES UN CONTEO, NO UN MOVIMIENTO ═══
 *
 * Esta es la decisión que gobierna todo el módulo. El cliente resube su contabilidad completa
 * cada semana; si cada carga insertara una "entrada" por su cantidad, el stock se duplicaría
 * cada lunes.
 *
 * Lo que el archivo dice es "hoy tengo 40", no "entraron 40". Así que:
 *
 *   · SKU nuevo      → alta con existencia inicial (`createItem`, que ya registra su
 *                      movimiento de apertura).
 *   · SKU conocido   → un AJUSTE por la diferencia entre lo contado y lo que teníamos.
 *   · Sin diferencia → no se escribe nada.
 *
 * Eso hace que resubir el mismo archivo sea inofensivo por construcción, en la misma línea
 * que la deduplicación por huella del resto de la ingesta.
 *
 * ═══ NUNCA SE ESCRIBE `quantity_on_hand` DIRECTO ═══
 *
 * Todo pasa por `recordMovement`, que es su único escritor. Esa es la mitad del contrato del
 * inventario: cada saldo tiene un movimiento que lo explica. Un import que escribiera la
 * columna dejaría 211 unidades que ningún movimiento justifica, y la primera vez que alguien
 * pregunte de dónde salieron, el historial no sabría contestar.
 */

/** Índices de columna de una hoja de existencias. `null` = la hoja no la trae. */
export interface MapaDeInventario {
  sku: number | null;
  name: number | null;
  quantity: number | null;
  unitCost: number | null;
  reorderPoint: number | null;
  location: number | null;
  supplier: number | null;
}

/**
 * Encabezados que identifican cada columna, ya normalizados.
 *
 * `preciounitario` NO está en `unitCost` a propósito, y es el mismo cuidado que el prompt del
 * modelo exige: el precio unitario es lo que el negocio COBRA, el costo es lo que le COSTÓ.
 * Confundirlos infla el valor del inventario por el margen completo.
 */
const PISTAS: Record<keyof MapaDeInventario, string[]> = {
  sku: ['sku', 'codigo', 'codigoproducto', 'codigoarticulo', 'idinsumo', 'idproducto', 'clave'],
  name: ['nombreproducto', 'nombre', 'producto', 'insumo', 'articulo', 'descripcion'],
  quantity: [
    'cantidaddisponible',
    'stockactual',
    'existenciaactual',
    'existencias',
    'existencia',
    'stock',
    'cantidad',
  ],
  unitCost: ['costounitario', 'costopromedio', 'costo'],
  reorderPoint: ['puntoreorden', 'stockminimo', 'cantidadreorden', 'existenciaminima', 'minimo'],
  location: ['ubicacion', 'bodega', 'almacen'],
  supplier: ['proveedor'],
};

/**
 * Mapea las columnas de una hoja de existencias, o `null` si no se puede.
 *
 * Se exige CANTIDAD y alguna forma de identificar el artículo (SKU o nombre). Sin cantidad no
 * hay existencia que registrar, y sin identificador no hay a qué atribuirla; en cualquiera de
 * los dos casos importar sería inventar.
 *
 * Se recorre la lista de pistas EN ORDEN y gana la primera que aparezca en la hoja: las más
 * específicas van primero (`stockactual` antes que `stock`, `nombreproducto` antes que
 * `nombre`). Con el orden invertido, una hoja que trae las dos columnas se quedaría con la
 * genérica.
 */
export function mapearColumnasDeInventario(headerRow: unknown[]): MapaDeInventario | null {
  const normalizados = headerRow.map(normalizeHeader);
  const buscar = (pistas: string[]): number | null => {
    for (const pista of pistas) {
      const idx = normalizados.indexOf(pista);
      if (idx !== -1) return idx;
    }
    return null;
  };

  const mapa: MapaDeInventario = {
    sku: buscar(PISTAS.sku),
    name: buscar(PISTAS.name),
    quantity: buscar(PISTAS.quantity),
    unitCost: buscar(PISTAS.unitCost),
    reorderPoint: buscar(PISTAS.reorderPoint),
    location: buscar(PISTAS.location),
    supplier: buscar(PISTAS.supplier),
  };

  if (mapa.quantity === null) return null;
  if (mapa.sku === null && mapa.name === null) return null;
  return mapa;
}

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * INVENTARIO SERIALIZADO: CADA FILA ES UNA UNIDAD, Y POR ESO NO HAY COLUMNA DE CANTIDAD
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *
 * `mapearColumnasDeInventario` exige una columna de CANTIDAD, y esa exigencia es correcta para
 * el inventario que la vio nacer: el de una cafetería, donde una fila dice "café en grano,
 * 40 kg". Fungible, contado por cantidad.
 *
 * Un negocio de inventario SERIALIZADO no tiene esa columna y no tiene por qué: cada fila es
 * una unidad única identificada por su serie. Una concesionaria lista 260 vehículos con VIN;
 * la cantidad de cada uno es 1 y escribirla sería redundante. Lo mismo una joyería con
 * certificados, una inmobiliaria con matrículas, una distribuidora de maquinaria con números
 * de serie.
 *
 * Sin este camino, esas hojas no mapean, no importan nada, y —peor— siguen de largo hacia el
 * modelo, que ve costo + fecha + producto y concluye razonablemente que son costos de venta.
 * Fue exactamente lo que pasó con CarsGT el 2026-08-24: 260 vehículos EN STOCK contabilizados
 * como Q 36,4 M de costo de ventas, y el inventario del cliente en cero.
 *
 * ═══ QUIÉN DICE QUE LA HOJA ES SERIALIZADA ═══
 *
 * No este módulo, y no por vocabulario: lo dice el ESQUEMA del libro
 * (`lib/sheet-relations.ts`). Una hoja cuya clave es única por fila y a la que otra hoja
 * apunta es una tabla de entidades. Esa señal es la misma en todos los dominios y no exige
 * conocer el negocio, que es justo lo que la lista de `PISTAS` no puede lograr.
 */
export function mapearInventarioSerializado(
  headerRow: unknown[],
  columnaDeSerie: number,
): MapaDeInventario | null {
  const normalizados = headerRow.map(normalizeHeader);
  const buscar = (pistas: string[]): number | null => {
    for (const pista of pistas) {
      const idx = normalizados.indexOf(pista);
      if (idx !== -1) return idx;
    }
    return null;
  };

  if (columnaDeSerie < 0 || columnaDeSerie >= headerRow.length) return null;

  /*
   * La serie ES el SKU: identifica la unidad sin ambigüedad y es lo que la hoja de movimientos
   * usa para referirse a ella. `name` cae en la columna descriptiva si la hay (`Modelo`,
   * `Marca`), y si no, se reutiliza la serie — `importarInventario` ya acepta eso.
   *
   * `quantity: null` marca este mapa como serializado. El llamador cuenta 1 por fila; no se
   * inventa una columna que la hoja no tiene.
   */
  return {
    sku: columnaDeSerie,
    name: buscar(PISTAS.name),
    quantity: null,
    unitCost: buscar(PISTAS.unitCost),
    reorderPoint: buscar(PISTAS.reorderPoint),
    location: buscar(PISTAS.location),
    supplier: buscar(PISTAS.supplier),
  };
}

const celda = (row: unknown[], idx: number | null): unknown =>
  idx === null || idx < 0 || idx >= row.length ? null : row[idx];

const texto = (v: unknown): string | null => {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
};

/** Igual que `row-assembly.asNumber` en espíritu: se aceptan las dos formas de Excel. */
const numero = (v: unknown): number | null => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const s = texto(v);
  if (!s) return null;
  const limpio = s.replace(/[^0-9.,-]/g, '');
  if (limpio === '') return null;
  const ultimaComa = limpio.lastIndexOf(',');
  const ultimoPunto = limpio.lastIndexOf('.');
  const n = Number(
    ultimaComa > ultimoPunto
      ? limpio.replace(/\./g, '').replace(',', '.')
      : limpio.replace(/,/g, ''),
  );
  return Number.isFinite(n) ? n : null;
};

export interface ResultadoDeImportacion {
  /** SKUs que no existían y se dieron de alta con su existencia inicial. */
  creados: number;
  /** SKUs que ya existían y cuyo conteo difería: se registró un ajuste. */
  ajustados: number;
  /** SKUs cuyo conteo coincidía con lo que teníamos: no se escribió nada. */
  sinCambio: number;
  /** Filas que no se pudieron leer (sin identificador o sin cantidad válida). */
  omitidas: number;
}

export interface ImportarInventarioParams {
  companyId: string;
  /** La carga que originó estos movimientos, para poder deshacerlos al revertirla. */
  documentId: string;
  /** A quién se le atribuyen los movimientos: quien subió el archivo. */
  userId: string;
  headerRow: unknown[];
  rows: unknown[][];
  baseCurrency: Currency;
  /**
   * Mapa ya resuelto. Lo usa el camino de inventario SERIALIZADO, donde la hoja no se
   * reconoce por sus encabezados sino por el esquema del libro. Omitirlo mantiene el
   * comportamiento de siempre: se mapea por vocabulario.
   */
  mapa?: MapaDeInventario | null;
}

/**
 * Aplica una hoja de existencias al inventario de la empresa.
 *
 * El caller decide la transacción. Cada artículo se resuelve por su cuenta y un fallo de uno
 * NO tumba el resto: una fila con un SKU imposible o un costo negativo es un problema de esa
 * fila, y abortar las otras doscientas por ella sería perder el inventario entero del cliente
 * por un dato suelto. Se cuenta en `omitidas`.
 */
export async function importarInventario(
  db: DB,
  params: ImportarInventarioParams,
): Promise<ResultadoDeImportacion> {
  /*
   * El mapa puede venir dado: una hoja de inventario SERIALIZADO no se reconoce por sus
   * encabezados sino por el esquema del libro, y quien tiene esa información es el worker.
   * Cuando no viene, se resuelve como siempre por vocabulario.
   */
  const mapa = params.mapa ?? mapearColumnasDeInventario(params.headerRow);
  const out: ResultadoDeImportacion = { creados: 0, ajustados: 0, sinCambio: 0, omitidas: 0 };
  if (!mapa) {
    out.omitidas = params.rows.length;
    return out;
  }

  for (const row of params.rows) {
    /*
     * El SKU es la identidad; si la hoja no trae columna de SKU se usa el nombre. Es lo que
     * hace el cliente que lleva su bodega por nombre de producto, que es común en una PYME —
     * y sin este fallback su inventario no se podría importar nunca.
     */
    const skuCrudo = texto(celda(row, mapa.sku)) ?? texto(celda(row, mapa.name));
    const nombre = texto(celda(row, mapa.name)) ?? skuCrudo;
    /*
     * Sin columna de cantidad la hoja es SERIALIZADA y cada fila vale UNA unidad. No es un
     * valor por defecto para salir del paso: es lo que la fila dice — un VIN es un vehículo.
     * El camino fungible sigue exigiendo el número, y una hoja sin cantidad NI serie no llega
     * hasta acá porque su mapa es `null`.
     */
    const contado = mapa.quantity === null ? 1 : numero(celda(row, mapa.quantity));

    if (!skuCrudo || !nombre || contado === null || contado < 0) {
      out.omitidas++;
      continue;
    }

    try {
      const [existente] = await db
        .select({ id: inventoryItems.id, quantityOnHand: inventoryItems.quantityOnHand })
        .from(inventoryItems)
        .where(
          and(
            eq(inventoryItems.companyId, params.companyId),
            isNull(inventoryItems.deletedAt),
            rawSql`lower(${inventoryItems.sku}) = ${skuCrudo.toLowerCase()}`,
          ),
        )
        .limit(1);

      if (!existente) {
        await createItem(db, params.companyId, params.userId, {
          documentId: params.documentId,
          sku: skuCrudo,
          name: nombre,
          quantityOnHand: contado,
          reorderPoint: numero(celda(row, mapa.reorderPoint)) ?? 0,
          unitCost: numero(celda(row, mapa.unitCost)) ?? 0,
          unitCostCurrency: params.baseCurrency,
          location: texto(celda(row, mapa.location)),
          supplier: texto(celda(row, mapa.supplier)),
        });
        out.creados++;
        continue;
      }

      const enSistema = Number(existente.quantityOnHand);
      const delta = contado - enSistema;

      // Sin diferencia no hay nada que registrar. `recordMovement` además rechaza un ajuste
      // de cero, así que esto no es solo una optimización: es la condición para que resubir
      // el mismo archivo no falle.
      if (delta === 0) {
        out.sinCambio++;
        continue;
      }

      await recordMovement(db, params.companyId, params.userId, {
        itemId: existente.id,
        movementType: 'adjustment',
        quantity: delta,
        // El motivo va en el ledger y es lo que contesta "¿de dónde salió este ajuste?"
        // dentro de seis meses.
        reason: `Conteo importado del archivo (${enSistema} → ${contado})`,
        documentId: params.documentId,
      });
      out.ajustados++;
    } catch (err) {
      // Un `InventoryError` es un problema de esta fila (SKU duplicado dentro del mismo
      // archivo, costo negativo). Cualquier otra cosa sí es un fallo de verdad y sube.
      if (!(err instanceof InventoryError)) throw err;
      out.omitidas++;
    }
  }

  return out;
}
