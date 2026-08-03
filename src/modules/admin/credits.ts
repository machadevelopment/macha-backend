import { Elysia, t } from 'elysia';
import { desc, eq } from 'drizzle-orm';
import { adminGuard } from '@/guards/admin.guard';
import { assertStaffCapability } from '@/guards/require-capability';
import { companies, creditTransactions } from '@/db/schema';
import { logAdminAction } from '@/lib/admin-audit';
import { getCreditBalance, recordCreditAdjustment } from '@/lib/credits';

/**
 * CU-868kjc7g5 / US-19: administrar créditos por empresa.
 *
 * EL ESTADO ANTERIOR. `credit_transactions` tenía exactamente dos escrituras en todo el
 * repositorio: el débito por consumo y el abono de una compra pagada por Recurrente. No
 * existía ninguna asignación ni top-up manual, así que TODA empresa arrancaba en 0: el
 * primer insight devolvía 402 y la alerta de saldo bajo —que calcula
 * `balance / monthlyAllotment` — daba 0% permanente y disparaba en cada evaluación
 * desde el primer día. La capacidad `topup_credits` existía en la matriz de permisos y
 * ninguna ruta la consumía.
 *
 * QUÉ ES ESTO Y QUÉ NO. Es el MECANISMO: abonar con una razón y poder leer el
 * movimiento. El MONTO de la asignación, su periodicidad y el mapeo crédito↔costo real
 * siguen abiertos (PRD §12 punto 4) y viven en `platform_settings`, no aquí.
 *
 * SIN JOB MENSUAL EN v1 (criterio 6). Acreditar a todas las empresas cada mes exige una
 * política de reseteo/rollover, que es justo la decisión pendiente. Lo que sí queda
 * automático es la asignación inicial al dar de alta la empresa
 * (`grantInitialCredits`); lo demás es manual y deja rastro.
 *
 * APPEND-ONLY. No hay PATCH ni DELETE, y no es un olvido: corregir un abono equivocado
 * es un POST con `delta` negativo y su propia razón. Por eso el body admite negativos.
 */
export const adminCredits = new Elysia({ prefix: '/admin/companies/:id/credits' })
  .use(adminGuard)
  .get('/', async ({ tier, params, set, db }) => {
    // Leer el saldo y el historial es parte de ver una empresa; abonar no (abajo).
    assertStaffCapability(tier, 'view_companies', set);

    const [company] = await db
      .select({ id: companies.id, name: companies.name })
      .from(companies)
      .where(eq(companies.id, params.id));
    if (!company) {
      set.status = 404;
      return { error: 'Company not found' };
    }

    const movements = await db
      .select({
        id: creditTransactions.id,
        delta: creditTransactions.delta,
        reason: creditTransactions.reason,
        actionKind: creditTransactions.actionKind,
        note: creditTransactions.note,
        refId: creditTransactions.refId,
        createdBy: creditTransactions.createdBy,
        createdAt: creditTransactions.createdAt,
      })
      .from(creditTransactions)
      .where(eq(creditTransactions.companyId, params.id))
      .orderBy(desc(creditTransactions.createdAt))
      .limit(200);

    // El saldo NO se lee de una columna materializada: es SUM(delta) sobre el ledger
    // (data model §13). Es la única cifra que no puede desincronizarse.
    return { companyId: company.id, balance: await getCreditBalance(db, params.id), movements };
  })
  .post(
    '/',
    async ({ staffId, tier, params, body, set, db }) => {
      // super_admin, no staff: mover créditos es mover dinero (Matriz 2).
      assertStaffCapability(tier, 'topup_credits', set);

      const [company] = await db
        .select({ id: companies.id })
        .from(companies)
        .where(eq(companies.id, params.id));
      if (!company) {
        set.status = 404;
        return { error: 'Company not found' };
      }

      const delta = Math.round(body.delta);
      if (delta === 0) {
        set.status = 400;
        return { error: 'El movimiento debe ser distinto de 0.' };
      }

      // La razón se exige aquí y no con un CHECK en la tabla para poder decir por qué
      // (US-19: "top-ups manuales CON RAZÓN"). Un abono sin razón es indistinguible de
      // un dedazo seis meses después.
      const note = body.note.trim();
      if (note.length < 3) {
        set.status = 400;
        return { error: 'La razón del movimiento es obligatoria.' };
      }

      const balanceBefore = await getCreditBalance(db, params.id);
      const { id } = await recordCreditAdjustment(db, {
        companyId: params.id,
        delta,
        reason: 'top_up',
        note,
        createdBy: staffId,
      });

      await logAdminAction(db, {
        actorStaffId: staffId,
        companyId: params.id,
        action: 'credit_transaction.create',
        targetTable: 'credit_transactions',
        targetId: id,
        // El saldo antes/después va en la auditoría porque es lo que un revisor quiere
        // ver sin recalcular el ledger entero.
        metadata: { delta, note, balanceBefore, balanceAfter: balanceBefore + delta },
      });

      set.status = 201;
      return { id, delta, balance: balanceBefore + delta };
    },
    {
      body: t.Object({
        // Entero con signo: negativo = fila compensatoria de un abono equivocado.
        delta: t.Integer(),
        note: t.String({ minLength: 3, maxLength: 500 }),
      }),
    },
  );
