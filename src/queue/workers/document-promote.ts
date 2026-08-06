import { eq } from 'drizzle-orm';
import { registerWorker, enqueue, QUEUES } from '@/queue';
import { withCompanyScope } from '@/lib/db-scope';
import { documents } from '@/db/schema';
import { promoteDocument } from '@/lib/promotion';
import { refreshExistingRollups } from '@/lib/rollups';

type DocumentPromotePayload = { documentId: string; companyId: string };

/**
 * Segunda oportunidad de promover un documento que quedó en `review`.
 *
 * EL AGUJERO QUE TAPA. `promoteDocument` se llamaba UNA sola vez, al final de la ingesta
 * (`excel-ingest.ts`). Si quedaban filas pendientes, el worker escribía `status='review'` y
 * terminaba. Staff aprobaba las filas desde `/admin/staging-rows` —un `PATCH` que escribía
 * `review_status` y la auditoría, y nada más— y ahí se cortaba todo: nadie volvía a llamar
 * a la promoción, nadie tocaba el estado del documento, y `POST /documents/:id/retry` solo
 * acepta documentos `failed` (un `review` recibe 409). El comentario de `excel-ingest.ts`
 * decía "la promoción atómica se reintenta cuando staff las resuelva" y ese reintento
 * nunca existió.
 *
 * Verificado contra producción el 2026-08-06, y no era un caso de borde: `transactions`,
 * `invoices` y `bills` tenían CERO filas, con 3.195 filas en staging y 9 documentos de los
 * cuales NINGUNO se promovió nunca. El pipeline no se había completado una sola vez desde
 * que existe.
 *
 * POR QUÉ ES UN JOB Y NO UNA LLAMADA DIRECTA desde la ruta admin: ver la nota de
 * `QUEUES.documentPromote`. Resumido, `/admin/*` está fuera de la cadena de guards con
 * tenant-scoping, y estos INSERT necesitan la conexión reservada con `app.company_id`
 * puesto o RLS los rechaza.
 */
export function startDocumentPromoteWorker(): Promise<string> {
  return registerWorker<DocumentPromotePayload>(
    QUEUES.documentPromote,
    async ({ documentId, companyId }) => {
      const promovido = await withCompanyScope(companyId, async (db) => {
        const resultado = await promoteDocument(db, companyId, documentId);

        // Ganó otra ejecución: el documento ya quedó bien y no hay que tocarlo.
        if (!resultado.promoted && resultado.reason === 'already_promoted') return false;

        if (!resultado.promoted && resultado.reason === 'pending_rows') {
          // Alguien subió filas nuevas, o dos revisiones corrieron a la vez y esta perdió.
          // Vuelve a `review` con el conteo real en vez de dejar el anterior, que ya miente.
          await db
            .update(documents)
            .set({ status: 'review', flaggedCount: resultado.pendingCount })
            .where(eq(documents.id, documentId));
          return false;
        }

        if (!resultado.promoted) {
          // `no_rows` (staging vacío) y `all_rejected` (staff miró todo y no sirvió nada).
          // Los dos son terminales y ninguno tiene datos que promover; se marcan
          // `unsupported`, que es el estado terminal sin datos que ya existe (migración
          // 0018). El `error_reason` los distingue, porque para el cliente NO son lo mismo:
          // uno es "no pudimos leer tu archivo", el otro "lo revisamos y no había nada
          // aprovechable".
          await db
            .update(documents)
            .set({
              status: 'unsupported',
              rowCount: 0,
              flaggedCount: 0,
              errorReason:
                resultado.reason === 'all_rejected'
                  ? 'La revisión interna descartó todas las filas de este archivo: ninguna quedó aprobada para promover.'
                  : 'No quedó ninguna fila en staging para promover.',
            })
            .where(eq(documents.id, documentId));
          return false;
        }

        await refreshExistingRollups(db, companyId);
        return true;
      });

      if (promovido) {
        // Mismo desacople que en la ingesta: la evaluación de alertas va por cola.
        await enqueue(QUEUES.alertEvaluate, { companyId, documentId });
      }
    },
  );
}
