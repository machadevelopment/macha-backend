import { and, eq, isNull } from 'drizzle-orm';
import type { DB } from '@/db/client';
import { stagingRows } from '@/db/schema';
import { claveDeConcepto, textoDeConcepto } from '@/lib/category-dictionary';
import { evaluateFlagReason } from '@/lib/staging-rules';

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * QUÉ LE PODEMOS PREGUNTAR AL CLIENTE — UNA SOLA DEFINICIÓN, TRES CONSUMIDORES
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *
 * Esto vivía dentro de `modules/ingestion/index.ts` y lo usaban el `GET` y el `POST` de
 * conceptos. Ahora hay un TERCER consumidor —el worker, que decide si mandar el correo de
 * "necesitamos que confirmes"— y ahí es donde una copia hace daño de verdad.
 *
 * ═══ POR QUÉ NO ALCANZA CON `flagged_count > 0` ═══
 *
 * El ticket pide disparar el correo "en el mismo punto donde hoy se escribe `status: 'review'`
 * con un `flaggedCount` mayor a 0". Tomado al pie de la letra manda correo por filas que el
 * cliente **no puede contestar**: una fila marcada por `invalid_date`, `invalid_amount` o
 * `invalid_currency` tiene un problema de DATO, no de significado, y ninguna categoría lo
 * arregla. Esas van por revisión interna.
 *
 * O sea que un documento marcado solo por fechas ilegibles produciría un correo que dice "6
 * filas que solo tú puedes clasificar", el cliente entra, y el panel le muestra CERO
 * preguntas. Es exactamente el fallo que `conceptos-pendientes` ya documenta haber corregido
 * del otro lado —*"la pantalla que existe para que el cliente resuelva sus filas le mostraba
 * cero conceptos"*— y sería peor por correo: lo interrumpimos para nada y le enseñamos a
 * ignorar el próximo aviso, que sí va a importar.
 *
 * Por eso el disparador cuenta **conceptos contestables**, no filas marcadas. Si da cero, no
 * hay correo: no es que se pierda el aviso, es que esa carga no es trabajo del cliente.
 *
 * ═══ Y POR QUÉ EL MISMO CÓDIGO Y NO UNO EQUIVALENTE ═══
 *
 * Porque el conteo del correo y la lista de la pantalla tienen que dar lo mismo o el producto
 * miente: "te quedaron 3 preguntas" y una pantalla con 5 es un cliente que deja de creerle al
 * correo. Este repo ya pagó esa lección dos veces (el `GET`/`POST` de conceptos buscando por
 * columnas distintas; `mesPorNombre` duplicado entre dos módulos), así que la regla es que
 * haya UNA definición y tres llamadas.
 */

/**
 * Motivos que una respuesta del cliente SÍ arregla, además de `low_confidence:*`.
 *
 * El problema es de SIGNIFICADO: el sistema no supo qué era, no pudo nombrarlo, o lo nombró
 * con un tipo que no existe. Un problema de DATO (sin fecha, sin monto, moneda desconocida) no
 * entra: preguntarlo sería pedir una respuesta que no cambia nada, dejándole además la
 * impresión de que ya lo resolvió.
 */
const MOTIVOS_ARREGLABLES = ['missing_category', 'invalid_type'] as const;

/**
 * ¿A esta fila marcada la arregla que el cliente diga qué es?
 *
 * Se compara por PREFIJO en `low_confidence` porque el motivo lleva el valor pegado
 * (`low_confidence:0.35`), y una igualdad exacta no casaría con ninguno.
 */
export function esArreglablePorCategoria(flagReason: string | null): boolean {
  if (flagReason === null) return false;
  if (flagReason.startsWith('low_confidence')) return true;
  return (MOTIVOS_ARREGLABLES as readonly string[]).includes(flagReason);
}

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * ¿LA RESPUESTA DEL CLIENTE DEJA ESTA FILA LISTA DE VERDAD? (2026-09-01)
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *
 * `esArreglablePorCategoria` mira el MOTIVO, y eso no alcanza: `evaluateFlagReason` devuelve
 * `low_confidence` ANTES de mirar la fecha, el monto y la moneda, así que una fila que además
 * tiene un problema de dato se presenta como contestable y **su problema real queda
 * escondido detrás de la confianza baja**.
 *
 * Lo que pasa entonces es lo peor que puede pasar en este flujo, y se midió en producción con
 * `libro-el-infierno`: una venta en EUR —moneda que no manejamos, conservada a propósito para
 * que se marque— llegó con confianza baja, se ofreció como concepto, el cliente la contestó, y
 * la respuesta le limpió la marca. Al promover, `resolveFxRate` no encontró tasa para EUR y
 * **lanzó**; la promoción es UNA transacción, así que se cayó la de las otras 17 filas
 * resueltas. El cliente vio los conceptos vaciarse, el dashboard sin moverse y ningún error en
 * ninguna parte: contestó 18 cosas y no aterrizó ni una.
 *
 * ═══ SE SIMULA LA RESPUESTA Y SE VUELVE A VALIDAR ═══
 *
 * La pregunta correcta no es "¿el motivo es de categoría?" sino "¿con una respuesta PERFECTA
 * esta fila quedaría limpia?". Eso se contesta con la misma `evaluateFlagReason` que decide
 * todo lo demás —confianza en 1, tipo y categoría puestos— en vez de con una segunda lista de
 * motivos que se separaría de la primera.
 *
 * Tres consumidores y tienen que coincidir: el `GET` (no preguntar lo que no se arregla), el
 * `POST` (no limpiar una marca que sobrevive a la respuesta) y el correo (no avisar por lo que
 * el cliente no puede resolver).
 */
export function quedaLimpiaAlContestar(fila: {
  targetEntity: 'transaction' | 'invoice' | 'bill';
  payload: Record<string, unknown>;
}): boolean {
  return (
    evaluateFlagReason({
      targetEntity: fila.targetEntity,
      // Una respuesta del dueño de la contabilidad vale 1: es la misma que aplica el `POST`.
      confidence: 1,
      payload: { ...fila.payload, type: 'opex', category: 'x' },
    }) === null
  );
}

/**
 * Cuántos CONCEPTOS distintos puede contestar el cliente en este documento.
 *
 * Cuenta conceptos y no filas, con la MISMA normalización que usa la pantalla
 * (`claveDeConcepto` sobre `textoDeConcepto`), porque es la cifra que va en el correo y tiene
 * que ser la que el cliente va a ver. Un archivo con 400 filas marcadas puede tener seis
 * conceptos: decirle "400" lo asusta y decirle "6" es la verdad.
 *
 * ⚠️ Solo mira filas `pending` y sin promover, igual que el `GET`: una fila que staff ya
 * resolvió no es una pregunta abierta.
 */
export async function contarConceptosPendientes(
  db: DB,
  companyId: string,
  documentId: string,
): Promise<number> {
  const filas = await db
    .select({
      payload: stagingRows.payload,
      flagReason: stagingRows.flagReason,
      // La entidad la necesita `quedaLimpiaAlContestar`: una factura y una transacción se
      // validan distinto, así que sin ella el conteo del correo juzgaría con otra regla.
      targetEntity: stagingRows.targetEntity,
    })
    .from(stagingRows)
    .where(
      and(
        // El scope por empresa va ADEMÁS del documento, no en su lugar: es la regla que este
        // proyecto no negocia, y una consulta correcta por accidente deja de serlo en cuanto
        // alguien la copia.
        eq(stagingRows.companyId, companyId),
        eq(stagingRows.documentId, documentId),
        eq(stagingRows.reviewStatus, 'pending'),
        isNull(stagingRows.promotedAt),
      ),
    );

  const claves = new Set<string>();
  for (const f of filas) {
    if (!esArreglablePorCategoria(f.flagReason)) continue;
    // Ver `quedaLimpiaAlContestar`: no se avisa por lo que una respuesta no deja listo.
    if (!quedaLimpiaAlContestar(f)) continue;
    const clave = claveDeConcepto(textoDeConcepto(f.payload));
    if (clave) claves.add(clave);
  }
  return claves.size;
}
