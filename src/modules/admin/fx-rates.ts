import { Elysia, t } from 'elysia';
import { and, desc, eq } from 'drizzle-orm';
import { adminGuard } from '@/guards/admin.guard';
import { assertStaffCapability } from '@/guards/require-capability';
import { companies, fxRates } from '@/db/schema';
import { ESQUEMA_TASA } from '@/lib/fx';
import { logAdminAction } from '@/lib/admin-audit';
import { counterCurrency, type Currency } from '@/lib/fx';

/**
 * CU-868kjc6h1 criterio 1: la vía mínima para que exista una tasa de cambio. Hasta aquí
 * ninguna ruta, script ni seed escribía en `fx_rates`, así que la única forma de
 * desbloquear a una empresa con un Excel en dos monedas era entrar a la base a mano.
 *
 * ES EL MÍNIMO OPERATIVO, NO LA SOLUCIÓN FINAL. Quién mantiene la tasa (staff o el
 * propio cliente) sigue abierto en PRD §12.2; CU-868kj3gm0 construye la pantalla del
 * cliente encima cuando esa decisión se cierre. Por eso vive en `/admin/*` y detrás de
 * `manage_companies` (super_admin): mover la tasa mueve TODAS las cifras convertidas
 * que se promuevan después.
 *
 * `base_currency` NO se acepta del cliente: sale de `companies.base_currency`. Una tasa
 * con una base distinta a la de la empresa nunca la encontraría el lookup de la
 * promoción — sería una fila muerta que además parecería configurada.
 */
export const adminFxRates = new Elysia({ prefix: '/admin/companies/:id/fx-rates' })
  .use(adminGuard)
  .get('/', async ({ tier, params, set, db }) => {
    assertStaffCapability(tier, 'view_companies', set);

    const [company] = await db
      .select({ baseCurrency: companies.baseCurrency })
      .from(companies)
      .where(eq(companies.id, params.id));
    if (!company) {
      set.status = 404;
      return { error: 'Company not found' };
    }

    const rows = await db
      .select({
        id: fxRates.id,
        baseCurrency: fxRates.baseCurrency,
        quoteCurrency: fxRates.quoteCurrency,
        rate: fxRates.rate,
        effectiveDate: fxRates.effectiveDate,
        createdAt: fxRates.createdAt,
      })
      .from(fxRates)
      .where(eq(fxRates.companyId, params.id))
      .orderBy(desc(fxRates.effectiveDate));

    // La moneda del par se devuelve calculada para que la pantalla no tenga que saber
    // que el producto solo maneja GTQ/USD (PRD §8).
    return {
      baseCurrency: company.baseCurrency,
      quoteCurrency: counterCurrency(company.baseCurrency as Currency),
      rates: rows,
    };
  })
  .post(
    '/',
    async ({ staffId, tier, params, body, set, db }) => {
      assertStaffCapability(tier, 'manage_companies', set);

      const [company] = await db
        .select({ baseCurrency: companies.baseCurrency })
        .from(companies)
        .where(eq(companies.id, params.id));
      if (!company) {
        set.status = 404;
        return { error: 'Company not found' };
      }

      const base = company.baseCurrency as Currency;
      if (body.quoteCurrency === base) {
        set.status = 400;
        return {
          error: `${base} es la moneda base de esta empresa: convierte a 1 y no necesita tasa.`,
        };
      }
      if (body.rate <= 0) {
        set.status = 400;
        return { error: 'La tasa debe ser mayor que 0.' };
      }

      const [existing] = await db
        .select({ id: fxRates.id, rate: fxRates.rate })
        .from(fxRates)
        .where(
          and(
            eq(fxRates.companyId, params.id),
            eq(fxRates.baseCurrency, base),
            eq(fxRates.quoteCurrency, body.quoteCurrency),
            eq(fxRates.effectiveDate, body.effectiveDate),
          ),
        );

      // `fx_rates` NO es un ledger append-only (no está en la lista de CLAUDE.md), así
      // que corregir un dedazo es legítimo: se sobrescribe la fila de esa fecha y la
      // auditoría guarda el antes/después. Lo ya promovido no se toca — cada fila
      // financiera congeló su `fx_rate` al promoverse (ver cabecera de lib/fx.ts).
      if (existing) {
        await db
          .update(fxRates)
          .set({ rate: String(body.rate), createdBy: staffId })
          .where(eq(fxRates.id, existing.id));

        await logAdminAction(db, {
          actorStaffId: staffId,
          companyId: params.id,
          action: 'fx_rate.update',
          targetTable: 'fx_rates',
          targetId: existing.id,
          metadata: {
            baseCurrency: base,
            quoteCurrency: body.quoteCurrency,
            effectiveDate: body.effectiveDate,
            before: existing.rate,
            after: String(body.rate),
          },
        });

        return { id: existing.id, replaced: true, appliesRetroactively: false };
      }

      const [created] = await db
        .insert(fxRates)
        .values({
          companyId: params.id,
          baseCurrency: base,
          quoteCurrency: body.quoteCurrency,
          rate: String(body.rate),
          effectiveDate: body.effectiveDate,
          // `created_by` no tiene FK en el schema; se guarda el `staff.id` que la
          // registró, igual que `credit_transactions.created_by` en un top-up manual.
          createdBy: staffId,
        })
        .returning({ id: fxRates.id });

      await logAdminAction(db, {
        actorStaffId: staffId,
        companyId: params.id,
        action: 'fx_rate.create',
        targetTable: 'fx_rates',
        targetId: created!.id,
        metadata: {
          baseCurrency: base,
          quoteCurrency: body.quoteCurrency,
          rate: String(body.rate),
          effectiveDate: body.effectiveDate,
        },
      });

      set.status = 201;
      // `appliesRetroactively: false` es contrato, no adorno: la pantalla tiene que poder
      // decirle a quien la registra que no recalcula lo ya promovido (criterio 5).
      return { id: created!.id, replaced: false, appliesRetroactively: false };
    },
    {
      body: t.Object({
        quoteCurrency: t.Union([t.Literal('GTQ'), t.Literal('USD')]),
        // Estrictamente positiva. El porqué —y por qué vive en un solo lugar— en `lib/fx.ts`.
        rate: ESQUEMA_TASA,
        // date-only, no timestamp: la vigencia es por día (data model §4.10).
        effectiveDate: t.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}$' }),
      }),
    },
  );
