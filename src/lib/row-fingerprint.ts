import { createHash } from 'node:crypto';
import { and, eq, inArray, ne } from 'drizzle-orm';
import type { DB } from '@/db/client';
import { documents, ingestedRows } from '@/db/schema';

/**
 * Huella estable de una fila cruda de Excel, para deduplicar ANTES de llamar a la IA.
 *
 * ═══ EL PROBLEMA QUE RESUELVE ═══
 *
 * Un cliente exporta su contabilidad completa y la sube cada semana. La semana 2 son las
 * mismas 5.000 filas más 200 nuevas. Hoy el sistema le manda las 5.200 a Claude y se paga
 * por las 5.000 que ya estaban procesadas.
 *
 * La idempotencia que YA existía no cubre esto, y la distinción importa:
 *   · `document_ingest_batches` evita reprocesar el MISMO documento (un reintento).
 *   · `staging_rows.promoted_at` evita promover dos veces la MISMA fila de staging.
 * Las dos protegen contra repetir un documento. Ninguna protege contra un documento NUEVO
 * que contiene filas viejas — que es el caso semanal, y el único que cuesta dinero de
 * verdad.
 *
 * Deduplicar al INSERTAR tampoco sirve para el costo: si la fila ya se le mandó a Claude,
 * ya se pagó, aunque después no se inserte. Por eso esta huella se calcula sobre la fila
 * CRUDA, antes de clasificar: es lo único que se puede saber sin gastar un token.
 *
 * ═══ POR QUÉ LLEVA UN ORDINAL ═══
 *
 * Dos ventas iguales el mismo día por el mismo monto NO son un duplicado: son dos ventas
 * reales. Una huella sobre el contenido solo las colapsaría en una y se perdería plata del
 * cliente — un error mucho peor que pagar de más.
 *
 * Por eso la huella no es del contenido sino del par (contenido, ordinal de aparición). Dos
 * filas idénticas en el mismo archivo producen `…#1` y `…#2`. Al resubir el archivo, las
 * mismas dos vuelven a producir `…#1` y `…#2` y ambas se reconocen. Si el archivo nuevo
 * trae una TERCERA, esa produce `…#3`, que no existe, y sí va a la IA. Es exactamente el
 * comportamiento que se quiere en los dos casos.
 *
 * ═══ QUÉ ENTRA Y QUÉ NO ═══
 *
 * Entra el nombre de la HOJA: la misma fila en dos hojas distintas de un libro es
 * normalmente el mismo movimiento visto dos veces (un resumen y un detalle), pero pueden
 * ser dos movimientos reales en libros distintos. Separar por hoja es la lectura
 * conservadora — a lo sumo se paga de más, nunca se pierde una fila.
 *
 * NO entra el `document_id` ni nada del archivo: si entrara, cada archivo nuevo daría
 * huellas nuevas y no se deduplicaría nada, que es justamente el bug que esto evita.
 */

/**
 * Normaliza una celda a texto comparable.
 *
 * El mismo Excel exportado dos veces puede traer `1500`, `1500.0` o `" 1500 "` para la
 * misma celda, según cómo lo guarde el sistema contable. Sin normalizar, esas tres darían
 * huellas distintas y la deduplicación no acertaría nunca — que es peor que no tenerla,
 * porque daría la falsa sensación de estar funcionando.
 *
 * NO se baja a minúsculas a propósito: en una descripción, "PAGO" y "pago" pueden venir de
 * dos asientos distintos, y colapsarlos perdería una fila real. La normalización se queda
 * en lo que es ruido de formato seguro — espacios y forma del número.
 */
export function normalizeCell(cell: unknown): string {
  if (cell === null || cell === undefined) return '';

  if (typeof cell === 'number') {
    // `Number.prototype.toString` ya colapsa 1500.0 → "1500" y 0.1+0.2 → "0.30000000000000004".
    // Se redondea a 6 decimales para que dos exportes del mismo monto con distinto error de
    // punto flotante den la misma huella. Seis decimales es holgado para dinero y para
    // cantidades por peso, que es lo más fino que maneja el producto.
    return Number.isFinite(cell) ? String(Number(cell.toFixed(6))) : '';
  }

  if (cell instanceof Date) {
    // Fecha a ISO de día: la hora en una celda de fecha de Excel es ruido de conversión,
    // no dato. Dos exportes del mismo día pueden traer 00:00:00 y 00:00:00.000Z.
    return Number.isNaN(cell.getTime()) ? '' : cell.toISOString().slice(0, 10);
  }

  if (typeof cell === 'boolean') return String(cell);

  // Cadena: se colapsa el espacio interno y se recortan los extremos. Un exporte puede
  // traer "Venta  mostrador" y otro "Venta mostrador" para el mismo asiento.
  return String(cell).trim().replace(/\s+/g, ' ');
}

/** La fila entera, normalizada y unida con un separador que no aparece en texto real. */
export function normalizeRow(cells: unknown[]): string {
  // `` como separador: si se usara una coma, una celda que contenga una coma podría
  // producir la misma cadena que dos celdas distintas ("a,b" vs ["a","b"]).
  return cells.map(normalizeCell).join('');
}

/**
 * Huella de una fila. `ordinal` arranca en 1 y distingue filas legítimamente idénticas.
 *
 * Se incluye `companyId` dentro del hash y no solo en la consulta: una huella que colisione
 * entre empresas sería una fuga de aislamiento silenciosa — la fila de una empresa haría que
 * la de otra se saltara la IA. La consulta ya filtra por empresa; esto es el cinturón.
 */
export function rowFingerprint(params: {
  companyId: string;
  sheetName: string;
  cells: unknown[];
  ordinal: number;
}): string {
  const material = [
    params.companyId,
    params.sheetName.trim(),
    normalizeRow(params.cells),
    `#${params.ordinal}`,
  ].join('');

  return createHash('sha256').update(material).digest('hex');
}

/**
 * Calcula la huella de cada fila de una hoja, asignando el ordinal por orden de aparición.
 *
 * Devuelve un arreglo alineado con `rows` (misma longitud, mismo orden) para que el llamador
 * pueda filtrar sin perder la correspondencia con la fila cruda que después le manda al
 * modelo.
 */
export function fingerprintSheet(params: {
  companyId: string;
  sheetName: string;
  rows: unknown[][];
}): string[] {
  const vistos = new Map<string, number>();

  return params.rows.map((cells) => {
    const clave = normalizeRow(cells);
    const ordinal = (vistos.get(clave) ?? 0) + 1;
    vistos.set(clave, ordinal);
    return rowFingerprint({
      companyId: params.companyId,
      sheetName: params.sheetName,
      cells,
      ordinal,
    });
  });
}

/**
 * Estados de documento cuyas filas están —o van a estar— VIVAS en producción.
 *
 * Solo una huella registrada por uno de estos puede bloquear una carga nueva. La lista es
 * corta a propósito: cada estado que entra acá es una promesa de que esos datos ya le
 * sirven al cliente.
 *
 *   · `promoted` — sus filas están en producción.
 *   · `review`   — promoción PARCIAL (migración 0020): lo limpio ya entró y lo dudoso entra
 *                  a medida que staff lo resuelve. Tiene datos vivos.
 *   · `queued` / `processing` — todavía no, pero un job en vuelo está a punto de promoverlas,
 *                  y filtrar aquí evita que dos cargas simultáneas del mismo archivo se
 *                  dupliquen entre sí.
 */
const ESTADOS_CON_DATOS_VIVOS = ['promoted', 'review', 'queued', 'processing'] as const;

/**
 * Cuáles de estas huellas YA se ingirieron para esta empresa **y siguen contando**, ignorando
 * las que registró el documento actual.
 *
 * Lo de "ignorando el documento actual" es lo que mantiene estable el plan de lotes entre
 * reintentos del mismo archivo: si el intento 1 registró huellas y el intento 2 las
 * filtrara, el lote `n` cubriría filas distintas y la guarda de reanudación abortaría la
 * carga. Ver el comentario largo en `queue/workers/excel-ingest.ts`.
 *
 * ═══ POR QUÉ SE MIRA EL ESTADO DEL DOCUMENTO (bug reportado por Jose, 2026-08-14) ═══
 *
 * Síntoma textual: *"cuando se borra un archivo y luego se carga otro, aparece como done pero
 * no se actualiza la data"*.
 *
 * La consulta solo excluía el documento actual, así que las huellas de un documento REVERTIDO
 * seguían bloqueando. El cliente revertía una carga y volvía a subir el mismo archivo: todas
 * sus filas se filtraban como "ya ingeridas", el documento llegaba a la promoción sin nada, y
 * terminaba en `promoted` con el mensaje "ya teníamos todo". Cero datos.
 *
 * Y no era recuperable: mientras la huella existiera, ese archivo quedaba **permanentemente**
 * bloqueado. Revertir era un viaje de ida.
 *
 * El mismo agujero afectaba a `cancelled`, `failed` y `unsupported`: los cuatro dejan huellas
 * registradas y ninguno deja filas vivas en producción, así que los cuatro bloqueaban datos
 * que el cliente nunca llegó a tener.
 *
 * ═══ POR QUÉ NO SE BORRAN LAS HUELLAS AL REVERTIR ═══
 *
 * Sería lo obvio y es peor. La migración `0024` ya razonó que revertir no debe borrarlas —una
 * huella significa "esta fila ya se le mostró al modelo", y eso no deja de ser cierto porque
 * después se revierta— y además `ingested_rows` es de solo INSERT para el rol de la app: no
 * hay DELETE que ejecutar aunque se quisiera.
 *
 * Filtrar por estado conserva las dos propiedades: el historial de lo que se pagó queda
 * intacto, y lo que no tiene datos vivos deja de bloquear.
 *
 * Se consulta en trozos porque una hoja grande puede traer miles de huellas y Postgres tiene
 * un techo de parámetros por sentencia; 1.000 es holgado y deja margen.
 */
export async function findSeenFingerprints(
  db: DB,
  companyId: string,
  currentDocumentId: string,
  fingerprints: string[],
): Promise<Set<string>> {
  const encontradas = new Set<string>();
  if (fingerprints.length === 0) return encontradas;

  // Únicas: una hoja puede repetir la misma huella si el archivo trae la fila dos veces con
  // ordinales distintos... no puede, por construcción. Pero deduplicar acá abarata la
  // consulta sin costar nada.
  const unicas = [...new Set(fingerprints)];

  for (let i = 0; i < unicas.length; i += 1_000) {
    const trozo = unicas.slice(i, i + 1_000);
    const filas = await db
      .select({ fingerprint: ingestedRows.fingerprint })
      .from(ingestedRows)
      // INNER JOIN y no LEFT: una huella cuyo documento ya no existe no puede acreditar que
      // sus datos estén vivos, así que tampoco debe bloquear.
      .innerJoin(documents, eq(documents.id, ingestedRows.firstSeenDocumentId))
      .where(
        and(
          eq(ingestedRows.companyId, companyId),
          ne(ingestedRows.firstSeenDocumentId, currentDocumentId),
          inArray(ingestedRows.fingerprint, trozo),
          inArray(documents.status, [...ESTADOS_CON_DATOS_VIVOS]),
        ),
      );
    for (const f of filas) encontradas.add(f.fingerprint);
  }

  return encontradas;
}
