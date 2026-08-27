import { Elysia, t } from 'elysia';
import { and, asc, eq, isNull, sql as rawSql } from 'drizzle-orm';
import { tenantDerive } from '@/guards/tenant.derive';
import { assertClientCapability } from '@/guards/require-capability';
import { enforceTokenBucket, rateLimitedResponse } from '@/lib/rate-limit';
import { invoices, bills } from '@/db/schema';

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * CUENTAS POR COBRAR Y POR PAGAR, UNA POR UNA — Y PODER DARLAS POR SALDADAS
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *
 * CU-868kx4cr6. Jose: *"en Cuentas por Cobrar, analizar el estatus de la cuenta; si ya está
 * pagada, se debería restar del balance abierto. Actualmente sale el capital completo de las
 * cuentas aunque ya están pagadas."*
 *
 * El diagnóstico del ticket es correcto y conviene repetirlo porque explica el alcance: no era
 * un error de cálculo. `GET /ar-ap` ya filtra `status = 'open'` antes de sumar. Lo que faltaba
 * es que ALGO escribiera `paid` alguna vez — **no existía ni un endpoint, ni un botón, ni un
 * proceso** que hiciera esa transición. La columna estaba declarada y nadie la tocaba nunca, así
 * que el balance abierto era la suma de todo lo que la empresa facturó en su historia.
 *
 * ═══ MANUAL Y NO AUTOMÁTICO, QUE ERA LA PREGUNTA ABIERTA DEL TICKET ═══
 *
 * El ticket dejaba a decidir entre marcar a mano o detectar el cobro en el Excel que se resube.
 * Se elige lo primero, y no por ser lo más chico:
 *
 *   · lo automático necesita ANTES una definición de producto que no existe —qué señal de un
 *     archivo cuenta como "esta factura ya se cobró"— y esa decisión no la puede tomar el
 *     código. Construirlo sin ella sería adivinar sobre la contabilidad de un cliente.
 *   · lo manual desbloquea hoy el problema reportado y **no se opone** a lo automático: cuando
 *     exista, escribirá el mismo campo por esta misma puerta. `settled_transaction_id` ya está
 *     en el esquema esperando justamente eso.
 *
 * ═══ SE PUEDE DESHACER, Y ESO NO ES UN EXTRA ═══
 *
 * `PATCH` acepta `open` además de `paid`. Marcar la factura equivocada es el error más probable
 * de esta pantalla —son filas parecidas, con el mismo cliente y montos similares— y sin vuelta
 * atrás la única salida sería revertir la carga entera. Es además lo que hace defendible que un
 * `member` pueda ejercerlo (ver `settle_receivables` en `lib/permissions.ts`).
 *
 * ═══ QUÉ NO HACE ═══
 *
 * **No crea ni borra filas del ledger, ni toca un solo monto.** Cambia un estado y nada más.
 * Esa acotación es deliberada: la única vía de entrada de datos financieros sigue siendo un
 * Excel promovido, que es lo que mantiene auditable el ledger (ver `modules/transactions`).
 */

/** Las dos caras del mismo asunto. `ar` = por cobrar (invoices), `ap` = por pagar (bills). */
const TABLA = { ar: invoices, ap: bills } as const;
type Cara = keyof typeof TABLA;

export const receivables = new Elysia({ prefix: '/receivables' })
  .use(tenantDerive)
  /**
   * Las cuentas de una cara, de la más vencida a la más nueva.
   *
   * `view_dashboard_reports` y no `settle_receivables`: es el mismo dato que ya alimenta el
   * aging de `/ar-ap`, visto fila por fila. Quien puede ver el total puede ver de qué sale.
   */
  .get(
    '/:cara',
    async ({ companyId, role, params, query, set, db }) => {
      assertClientCapability(role, 'view_dashboard_reports', set);

      const limited = await enforceTokenBucket('read', companyId, set, 'GET /receivables');
      if (limited) return limited;

      const tabla = TABLA[params.cara as Cara];
      const limit = Math.min(query.limit ?? 50, 200);

      /*
       * `company_id` explícito además del GUC de RLS: la regla no negociable es que el scoping
       * salga del filtro y RLS sea el respaldo, nunca al revés.
       */
      const condiciones = [eq(tabla.companyId, companyId), isNull(tabla.deletedAt)];
      if (query.status) condiciones.push(eq(tabla.status, query.status));

      const filas = await db
        .select({
          id: tabla.id,
          counterparty: tabla.counterparty,
          issueDate: tabla.issueDate,
          dueDate: tabla.dueDate,
          originalAmount: tabla.originalAmount,
          originalCurrency: tabla.originalCurrency,
          amountBase: tabla.amountBase,
          status: tabla.status,
        })
        .from(tabla)
        .where(and(...condiciones))
        /*
         * Por vencimiento ascendente: lo más vencido primero, que es el orden en que alguien
         * cobra. `nulls last` porque una cuenta sin fecha de vencimiento no es la más urgente —
         * es la que no se sabe, y encabezar la lista con ella empujaría fuera de pantalla lo que
         * de verdad urge.
         */
        .orderBy(rawSql`${tabla.dueDate} asc nulls last`, asc(tabla.issueDate))
        .limit(limit)
        .offset(query.offset ?? 0);

      return { rows: filas.map((f) => ({ ...f, amountBase: Number(f.amountBase) })) };
    },
    {
      params: t.Object({ cara: t.Union([t.Literal('ar'), t.Literal('ap')]) }),
      query: t.Object({
        status: t.Optional(t.Union([t.Literal('open'), t.Literal('paid')])),
        limit: t.Optional(t.Integer({ minimum: 1, maximum: 200 })),
        offset: t.Optional(t.Integer({ minimum: 0 })),
      }),
      response: { 429: rateLimitedResponse },
    },
  )
  /**
   * Dar por saldada una cuenta, o deshacerlo.
   */
  .patch(
    '/:cara/:id',
    async ({ companyId, role, params, body, set, db }) => {
      assertClientCapability(role, 'settle_receivables', set);

      const tabla = TABLA[params.cara as Cara];

      /*
       * El `where` lleva `company_id` Y `deleted_at is null`. Lo primero porque la PK es
       * compuesta y sin él el UPDATE tocaría la fila de otra empresa que compartiera `id`; lo
       * segundo porque una fila de una carga revertida no debe poder volver a la vida por un
       * cambio de estado — reaparecería en el balance abierto sin que nadie la haya cargado.
       */
      const [fila] = await db
        .update(tabla)
        .set({ status: body.status, updatedAt: new Date() })
        .where(
          and(eq(tabla.companyId, companyId), eq(tabla.id, params.id), isNull(tabla.deletedAt)),
        )
        .returning({ id: tabla.id, status: tabla.status });

      if (!fila) {
        set.status = 404;
        return { error: 'Esa cuenta no existe en esta empresa.' };
      }
      return fila;
    },
    {
      params: t.Object({
        cara: t.Union([t.Literal('ar'), t.Literal('ap')]),
        id: t.String({ format: 'uuid' }),
      }),
      body: t.Object({ status: t.Union([t.Literal('open'), t.Literal('paid')]) }),
    },
  );
