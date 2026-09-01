import { Elysia, t } from 'elysia';
import { and, desc, eq, isNotNull, sql as rawSql } from 'drizzle-orm';
import { adminGuard } from '@/guards/admin.guard';
import { assertStaffCapability } from '@/guards/require-capability';
import { companies, documents } from '@/db/schema';

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA COLA DE CARGAS QUE NO CUADRAN — EL CANAL QUE LE FALTABA AL DETECTOR
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *
 * `lib/cuadre.ts` es lo único del pipeline capaz de detectar un fallo sobre **un archivo que
 * nadie vio nunca**: los tests cubren archivos que ya vimos, y por ese hueco pasaron siete
 * reportes de clientes seguidos. Pero su veredicto iba a `console.warn`, y en Railway los logs
 * no agregan, no alertan y rotan — verificado el 2026-08-31 buscando el diagnóstico de dos
 * cargas recién reportadas: ya no existía.
 *
 * `pool-watch.ts` ya había dejado escrita la misma lección sobre sí mismo: *"la detección está
 * construida; el canal de aviso es una variable de entorno que falta"*. Acá el canal es esta
 * pantalla.
 *
 * ═══ POR QUÉ UNA COLA Y NO UNA ALERTA ═══
 *
 * Un descuadre no es una excepción: es una MEDICIÓN que cruzó un umbral, y el detector no
 * bloquea nada a propósito (un falso positivo que frene la promoción deja al cliente sin su
 * contabilidad). Lo que hace falta es que alguien lo VEA, ordenado por gravedad, el mismo día —
 * no que suene una alarma por cada carga. Es el mismo criterio con el que se mira la cola de
 * filas marcadas.
 *
 * ═══ EL ORDEN ES POR FECHA Y NO POR GRAVEDAD, Y ES DELIBERADO ═══
 *
 * La gravedad de un descuadre no es comparable entre empresas: un ×2 sobre Q 500 y un ×2 sobre
 * Q 16 M dicen lo mismo del pipeline y cosas muy distintas del cliente. Ordenar por magnitud
 * pondría arriba a la empresa más grande y no al bug más nuevo, y lo que esta pantalla tiene
 * que contestar es "¿qué se rompió desde ayer?". La magnitud viaja en el detalle para poder
 * decidir a cuál mirar primero.
 */
export const adminReconciliation = new Elysia({ prefix: '/admin' }).use(adminGuard).get(
  '/reconciliation',
  async ({ tier, query, set, db }) => {
    /*
     * `view_job_status` y no una capacidad nueva: esto es exactamente eso — el estado de un
     * trabajo de ingesta, con más detalle. Una capacidad por pantalla haría que la matriz
     * creciera con el panel en vez de con los roles reales.
     */
    assertStaffCapability(tier, 'view_job_status', set);

    const limit = Math.min(query.limit ?? 50, 200);

    const filas = await db
      .select({
        documentId: documents.id,
        companyId: documents.companyId,
        companyName: companies.name,
        filename: documents.originalFilename,
        status: documents.status,
        createdAt: documents.createdAt,
        reconciliation: documents.reconciliation,
      })
      .from(documents)
      .innerJoin(companies, eq(companies.id, documents.companyId))
      .where(
        and(
          isNotNull(documents.reconciliation),
          /*
           * Solo las que NO cuadran. El filtro va en SQL y no en JavaScript porque la
           * inmensa mayoría de las cargas cuadra: traérselas todas para descartarlas acá
           * sería paginar sobre ruido y la pantalla mostraría dos resultados por página.
           */
          rawSql`${documents.reconciliation}->>'cuadra' = 'false'`,
        ),
      )
      .orderBy(desc(documents.createdAt))
      .limit(limit + 1);

    const hayMas = filas.length > limit;
    return {
      // Mismo patrón "load more" (limit+1) que el resto del panel.
      hayMas,
      cargas: filas.slice(0, limit).map((f) => ({
        documentId: f.documentId,
        companyId: f.companyId,
        companyName: f.companyName,
        filename: f.filename,
        status: f.status,
        createdAt: f.createdAt.toISOString(),
        reconciliation: f.reconciliation,
      })),
    };
  },
  {
    query: t.Object({ limit: t.Optional(t.Numeric({ minimum: 1, maximum: 200 })) }),
  },
);
