import { and, asc, eq, inArray } from 'drizzle-orm';
import type { DB } from '@/db/client';
import { companies, companyUsers, documents, notifications, users } from '@/db/schema';
import { contarConceptosPendientes } from '@/lib/conceptos-pendientes';
import { sendReviewNeededEmail } from '@/lib/email';
import { uploadDocumentUrl } from '@/lib/app-urls';

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * EL AVISO PROACTIVO: "TU ARCHIVO NECESITA TU ATENCIÓN" (CU-868kyur58)
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *
 * Hasta hoy, una carga que quedaba con conceptos sin clasificar solo se descubría si el cliente
 * volvía a entrar a la app por su cuenta. Sus filas se quedaban fuera del dashboard esperando
 * una respuesta que nadie le pidió.
 *
 * ═══ LAS TRES REGLAS DEL TICKET, Y CÓMO CONVIVEN ═══
 *
 * El ticket pide tres cosas que, tomadas literalmente, se contradicen entre sí:
 *
 *   1. disparar cuando un documento cae en `review` con filas marcadas;
 *   2. CONSOLIDAR — un solo correo si la empresa tiene varias cargas pendientes a la vez;
 *   3. NUNCA duplicar el correo del mismo documento.
 *
 * (2) y (3) chocan: si el archivo A termina y el B treinta segundos después, un correo
 * consolidado por empresa o se manda dos veces, o el segundo archivo nunca se menciona.
 *
 * **La resolución es que la unidad de IDEMPOTENCIA sea el documento y la unidad de MENSAJE sea
 * la empresa.** Cada envío escribe una fila de `notifications` por CADA documento que el correo
 * menciona, no solo por el que lo disparó. Entonces:
 *
 *   · A termina → correo que menciona A. Se marca A.
 *   · B termina → A ya está marcado, así que el correo menciona **solo B**. Se marca B.
 *   · Si A y B terminan juntos (el segundo entra cuando el primero aún no marcó), el correo
 *     menciona los dos y marca los dos: el que corra después no encuentra nada pendiente y
 *     no manda nada.
 *
 * Ninguna carga se queda sin avisar y ninguna se avisa dos veces. **No hace falta una columna
 * nueva**: `notifications` con `kind='review_needed'` + `ref_id=<documento>` YA es ese registro,
 * y encima es la tabla que el equipo puede mirar para saber qué se mandó.
 *
 * ═══ NO SE DISPARA POR FILAS MARCADAS SINO POR CONCEPTOS CONTESTABLES ═══
 *
 * Ver `lib/conceptos-pendientes.ts`. Una carga marcada solo por fechas ilegibles produce CERO
 * preguntas para el cliente: mandarle un correo sería interrumpirlo para llevarlo a una
 * pantalla vacía, y enseñarle a ignorar el próximo aviso.
 *
 * ═══ NUNCA TUMBA LA CARGA ═══
 *
 * Todo el bloque va envuelto: la contabilidad del cliente ya está promovida y correcta cuando
 * esto corre. Si Resend está caído o la cola no acepta el job, lo que se pierde es el aviso
 * —recuperable, el banner del Dashboard sigue ahí— y no la carga. Es el mismo criterio que ya
 * usan el diccionario de categorías y el cuadre.
 */

/** Estados en los que una carga está esperando una respuesta del cliente. */
/*
 * ⚠️ `awaiting_confirmation` entra acá (migración 0042) y es ahora el estado MÁS COMÚN de una
 * carga recién procesada: desde el portón, ninguna se promueve sola. Dejarlo fuera repetiría
 * el error que este mismo archivo documenta haber corregido —"el aviso se pierde el caso más
 * común"— pero al revés y peor: el correo es lo único que le dice al cliente que su
 * contabilidad está esperando su visto bueno, y sin él la carga se queda invisible para
 * siempre, que es exactamente el riesgo que el portón reintroduce.
 */
const ESPERANDO_AL_CLIENTE = ['review', 'promoted', 'awaiting_confirmation'] as const;

export interface ResultadoDelAviso {
  /** `false` si no había nada que avisar, o si ya se había avisado. */
  enviado: boolean;
  /** Documentos que este correo cubre (y que quedan marcados). */
  documentos: string[];
  conceptos: number;
  destinatarios: number;
  motivo?: 'sin_conceptos' | 'ya_avisado' | 'sin_destinatarios';
}

export async function avisarConceptosPendientes(
  db: DB,
  companyId: string,
  documentId: string,
): Promise<ResultadoDelAviso> {
  const vacio = (motivo: ResultadoDelAviso['motivo']): ResultadoDelAviso => ({
    enviado: false,
    documentos: [],
    conceptos: 0,
    destinatarios: 0,
    motivo,
  });

  /*
   * ═══ QUÉ CARGAS DE ESTA EMPRESA SIGUEN ESPERANDO AL CLIENTE ═══
   *
   * `promoted` entra además de `review` y no es un descuido: con promoción parcial (migración
   * 0020) el estado NORMAL de una carga con filas retenidas es `promoted` con
   * `flagged_count > 0`. Filtrar solo por `review` dejaría fuera justo el caso más común.
   *
   * Se ordena por fecha de creación para que el correo nombre los archivos en el orden en que
   * el cliente los subió, que es el orden en que los tiene en la cabeza.
   */
  const candidatos = await db
    .select({
      id: documents.id,
      filename: documents.originalFilename,
      flaggedCount: documents.flaggedCount,
      // Hace falta para distinguir "tiene preguntas" de "espera tu visto bueno".
      status: documents.status,
    })
    .from(documents)
    .where(
      and(eq(documents.companyId, companyId), inArray(documents.status, [...ESPERANDO_AL_CLIENTE])),
    )
    .orderBy(asc(documents.createdAt));

  /*
   * ═══════════════════════════════════════════════════════════════════════════════════════════
   * UNA CARGA SIN NADA MARCADO TAMBIÉN ESPERA AL CLIENTE (migración 0042)
   * ═══════════════════════════════════════════════════════════════════════════════════════════
   *
   * Antes el filtro era `flagged_count > 0`, y con el portón eso deja fuera el caso que MÁS
   * necesita el correo: una carga que el modelo entendió PERFECTO no tiene una sola fila
   * marcada, no dispara aviso, y su contabilidad se queda esperando una confirmación que nadie
   * le pidió — invisible para siempre. Es exactamente el riesgo que el portón reintroduce, y
   * el correo es la única mitigación que tiene.
   *
   * Así que ahora entra por CUALQUIERA de las dos vías: tiene filas que el cliente puede
   * contestar, **o** está esperando su confirmación. La copia del correo distingue las dos.
   */
  const conFlags = candidatos.filter(
    (d) => (d.flaggedCount ?? 0) > 0 || d.status === 'awaiting_confirmation',
  );
  if (conFlags.length === 0) return vacio('sin_conceptos');

  /*
   * Los que YA recibieron aviso quedan fuera del correo nuevo. La consulta se hace una sola vez
   * sobre los candidatos, no una por documento: en el onboarding esto corre cuatro veces
   * seguidas y una consulta por archivo por corrida es trabajo que crece al cuadrado.
   */
  const avisados = await db
    .select({ refId: notifications.refId })
    .from(notifications)
    .where(
      and(
        eq(notifications.companyId, companyId),
        eq(notifications.kind, 'review_needed'),
        inArray(
          notifications.refId,
          conFlags.map((d) => d.id),
        ),
      ),
    );
  const yaAvisado = new Set(avisados.map((a) => a.refId));

  /*
   * ⚠️ EL DOCUMENTO QUE DISPARA TIENE QUE ESTAR ENTRE LOS NUEVOS, O NO SE MANDA NADA.
   *
   * Sin esta condición, terminar una carga LIMPIA reabriría el aviso de otra que ya se había
   * avisado y sigue pendiente — el cliente recibiría un recordatorio cada vez que sube un
   * archivo, que es la definición de correo que se aprende a ignorar. El disparo lo causa
   * SIEMPRE una carga nueva; las viejas solo se suman al mensaje si todavía no se avisaron.
   */
  if (yaAvisado.has(documentId)) return vacio('ya_avisado');

  const nuevos = conFlags.filter((d) => !yaAvisado.has(d.id));
  if (!nuevos.some((d) => d.id === documentId)) return vacio('sin_conceptos');

  /*
   * Ahora sí, el conteo caro: cuántos CONCEPTOS distintos puede contestar. Va después de los
   * filtros de arriba a propósito — recorre las filas de staging de cada documento, y no tiene
   * sentido pagarlo por cargas que ya se avisaron.
   */
  let conceptos = 0;
  const cubiertos: { id: string; filename: string }[] = [];
  for (const d of nuevos) {
    const n = await contarConceptosPendientes(db, companyId, d.id);
    conceptos += n;
    /*
     * ⚠️ Una carga que espera confirmación entra AUNQUE no tenga una sola pregunta: el portón
     * la retiene igual, y sin correo se queda invisible. Lo que se sigue excluyendo es la que
     * ya está publicada y solo tiene filas marcadas por un problema de DATO —fecha ilegible,
     * moneda que no manejamos—: esas no las arregla ninguna categoría, así que llevar al
     * cliente a una pantalla vacía es peor que no avisar.
     */
    if (n === 0 && d.status !== 'awaiting_confirmation') continue;
    cubiertos.push({ id: d.id, filename: d.filename });
  }

  if (cubiertos.length === 0) return vacio('sin_conceptos');
  if (!cubiertos.some((d) => d.id === documentId)) return vacio('sin_conceptos');

  const [empresa] = await db
    .select({ locale: companies.locale })
    .from(companies)
    .where(eq(companies.id, companyId));

  /*
   * Mismos destinatarios que las alertas: miembros activos con `receives_reports`. No se
   * inventa un criterio nuevo — quien eligió no recibir el reporte tampoco quiere que le
   * escribamos por una carga.
   */
  const destinatarios = await db
    .select({ email: users.email })
    .from(companyUsers)
    .innerJoin(users, eq(users.id, companyUsers.userId))
    .where(
      and(
        eq(companyUsers.companyId, companyId),
        eq(companyUsers.status, 'active'),
        eq(companyUsers.receivesReports, true),
      ),
    );

  if (destinatarios.length === 0) return vacio('sin_destinatarios');

  /*
   * El CTA apunta al documento que DISPARÓ el aviso, incluso cuando el correo menciona varios:
   * es el que el cliente acaba de subir y el que tiene en la cabeza. Los demás están en la
   * misma pantalla, a la vista.
   */
  const ctaUrl = uploadDocumentUrl(documentId);

  for (const destinatario of destinatarios) {
    await sendReviewNeededEmail({
      companyId,
      locale: empresa?.locale ?? 'es',
      documentId,
      archivos: cubiertos.map((d) => d.filename),
      conceptos,
      recipientEmail: destinatario.email,
      ctaUrl,
    });
  }

  /*
   * ═══ LA MARCA DE IDEMPOTENCIA, UNA POR DOCUMENTO CUBIERTO ═══
   *
   * Va DESPUÉS de encolar y no antes: si la cola falla, no queremos haber marcado como avisada
   * una carga que nadie recibió. El riesgo inverso —encolar y no marcar— produce como mucho un
   * correo repetido, que es recuperable; marcar sin encolar produce un cliente que nunca se
   * entera, que no lo es.
   *
   * `status: 'queued'` porque eso es lo que son en este momento: el worker de correo actualiza
   * la suya al entregar. Estas filas son la marca de "ya se decidió avisar por esta carga".
   */
  await db.insert(notifications).values(
    cubiertos.map((d) => ({
      companyId,
      kind: 'review_needed' as const,
      recipientEmail: destinatarios[0]!.email,
      refId: d.id,
      status: 'queued' as const,
    })),
  );

  return {
    enviado: true,
    documentos: cubiertos.map((d) => d.id),
    conceptos,
    destinatarios: destinatarios.length,
  };
}
