import type { Sql } from 'postgres';
import type { promoteDocument as promoteDocumentTipo } from '@/lib/promotion';

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * CONFIRMAR LA CARGA, QUE DESDE LA MIGRACIÓN 0042 ES PARTE DEL FLUJO
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *
 * El portón: una carga recién procesada queda en `awaiting_confirmation` y **nada suyo entra al
 * dashboard** hasta que el dueño confirme lo que entendimos de su archivo. Los tests de punta a
 * punta que existían antes del portón prueban el PIPELINE —que el dinero del archivo llegue
 * bien al ledger— y no el portón, así que confirman y siguen, igual que haría el cliente.
 *
 * ⚠️ Se llama a `promoteDocument` y no se encola: en los tests la cola es un DOBLE, así que un
 * `enqueue` no ejecuta nada y el test pasaría a verde afirmando sobre un ledger vacío. Este
 * helper hace lo mismo que el worker de `document.promote` cuando el cliente aprieta publicar.
 *
 * Vive una sola vez porque son doce archivos: doce copias de "poner confirmed_at y promover" se
 * separan en cuanto el flujo cambie otra vez, y entonces la mitad de la suite estaría probando
 * un flujo que ya no existe.
 */
export async function confirmarYPromover(
  owner: Sql,
  companyId: string,
  documentId: string,
): Promise<void> {
  await owner`
    update documents set confirmed_at = now()
    where id = ${documentId} and company_id = ${companyId}
  `;
  /*
   * Se arma la conexión acá y no se recibe: cada test nombra la suya distinto (`db`, `sql`,
   * ninguna), y pedirle el parámetro convertía un helper de una línea en doce ediciones
   * distintas que se desincronizan.
   */
  const { drizzle } = await import('drizzle-orm/postgres-js');
  const schema = await import('@/db/schema');
  const db = drizzle(owner, { schema }) as unknown as Parameters<typeof promoteDocumentTipo>[0];
  const { promoteDocument } = await import('@/lib/promotion');
  const { refreshExistingRollups } = await import('@/lib/rollups');
  const r = await promoteDocument(db, companyId, documentId);
  if (r.promoted) {
    await owner`
      update documents set status = 'promoted', promoted_at = now(),
             row_count = coalesce(row_count, 0), flagged_count = ${r.pendingCount}
      where id = ${documentId}
    `;
    await refreshExistingRollups(db, companyId);
  }
}
