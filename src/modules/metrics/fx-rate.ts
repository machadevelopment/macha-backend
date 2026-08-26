import { Elysia, t } from 'elysia';
import { and, desc, eq } from 'drizzle-orm';
import { tenantDerive } from '@/guards/tenant.derive';
import { assertClientCapability } from '@/guards/require-capability';
import { companies, fxRates } from '@/db/schema';
import { counterCurrency, type Currency } from '@/lib/fx';

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * EL TIPO DE CAMBIO, MANTENIDO POR EL CLIENTE (decisión de Jose, 2026-08-25)
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *
 * La pregunta estaba abierta en PRD §12.2 y tenía este ticket bloqueado: ¿quién mantiene la
 * tasa GTQ↔USD, el equipo de Macha o el propio cliente? Hasta hoy era Macha —se cargaba desde
 * `/admin/companies/:id/fx-rates` y el cliente la veía sin poder tocarla—.
 *
 * Jose eligió el cliente, y explícitamente **cualquier admin de la empresa, no solo el dueño**:
 * *"el tipo de cambio no es tan sensible como para restringirlo tanto, y limitarlo solo al
 * dueño va a generar fricción en el día a día para algo que hay que ajustar seguido."*
 *
 * ═══ LO QUE HACE SEGURA ESA DECISIÓN, Y ES LO QUE LA DESBLOQUEÓ ═══
 *
 * **Cambiar la tasa nunca reescribe la contabilidad ya cargada.** Cada fila financiera congela
 * su `fx_rate` al promoverse (cabecera de `lib/fx.ts`), así que una tasa nueva aplica de ahí en
 * adelante y un ajuste de hoy no puede mover las cifras de marzo.
 *
 * Eso no es una promesa de esta ruta: es una propiedad del modelo de datos que ya existía. Por
 * eso `appliesRetroactively: false` viaja en la respuesta como CONTRATO y no como adorno — la
 * pantalla tiene que poder decírselo a quien está por cambiar una cifra que mueve dinero.
 *
 * ═══ LA RUTA DE `/admin/*` NO SE RETIRA ═══
 *
 * Sigue existiendo para soporte: un operador de Macha tiene que poder desbloquear a una empresa
 * cuyo admin no está disponible. Las dos escriben la misma tabla con la misma regla de
 * sobrescritura por fecha, y la de admin además escribe `admin_audit_log`, que es lo que
 * corresponde cuando quien toca los datos de una empresa no pertenece a ella.
 *
 * ⚠️ Lo que esta ruta NO hace es escribir `admin_audit_log`, y es a propósito: ese ledger es
 * para acciones de STAFF sobre una empresa ajena. Un admin del cliente cambiando su propia tasa
 * es una operación normal del producto, y `fx_rates.created_by` ya guarda quién la puso.
 *
 * ═══ POR QUÉ VIVE EN `metrics/` ═══
 *
 * Es el vecindario de la conversión de moneda del lado del cliente (`metricsCurrencies` está al
 * lado) y no hay un módulo de "ajustes de empresa" todavía. Cuando exista, se muda.
 */
export const clientFxRate = new Elysia({ prefix: '/fx-rate' })
  .use(tenantDerive)
  /**
   * La tasa vigente y el historial. Lo puede ver CUALQUIER rol.
   *
   * Ver no es tocar, y un `member` que sube un Excel en dos monedas necesita poder comprobar
   * con qué tasa se va a convertir lo que acaba de cargar — si no, el número del dashboard sale
   * de un dato que no puede auditar.
   */
  .get('/', async ({ companyId, db }) => {
    const [company] = await db
      .select({ baseCurrency: companies.baseCurrency })
      .from(companies)
      .where(eq(companies.id, companyId));

    // El guard ya resolvió la membresía contra esta empresa, así que existe. La guarda
    // defensiva es por si el registro se borrara entre el guard y esta consulta.
    const base = (company?.baseCurrency ?? 'GTQ') as Currency;

    const rates = await db
      .select({
        id: fxRates.id,
        baseCurrency: fxRates.baseCurrency,
        quoteCurrency: fxRates.quoteCurrency,
        rate: fxRates.rate,
        effectiveDate: fxRates.effectiveDate,
        createdAt: fxRates.createdAt,
      })
      .from(fxRates)
      .where(eq(fxRates.companyId, companyId))
      .orderBy(desc(fxRates.effectiveDate));

    return {
      baseCurrency: base,
      // Calculada acá para que la pantalla no tenga que saber que el producto solo maneja
      // GTQ/USD (PRD §8). Cuando haya una tercera, el frontend no cambia.
      quoteCurrency: counterCurrency(base),
      rates,
      /*
       * Que la tasa no es retroactiva es lo PRIMERO que la pantalla tiene que poder decir, y
       * viaja en el GET además del POST: quien abre la pantalla necesita saberlo antes de
       * escribir, no después de guardar.
       */
      appliesRetroactively: false,
    };
  })
  /**
   * Registra o corrige la tasa de una fecha. `owner` y `admin` (ver `manage_fx_rate`).
   */
  .post(
    '/',
    async ({ role, companyId, userId, body, set, db }) => {
      assertClientCapability(role, 'manage_fx_rate', set);

      const [company] = await db
        .select({ baseCurrency: companies.baseCurrency })
        .from(companies)
        .where(eq(companies.id, companyId));
      if (!company) {
        set.status = 404;
        return { error: 'Company not found' };
      }

      const base = company.baseCurrency as Currency;

      /*
       * `base_currency` NO se acepta del cliente: sale de `companies.base_currency`. Una tasa
       * con otra base nunca la encontraría el lookup de la promoción — sería una fila muerta
       * que además parecería configurada. Mismo criterio que la ruta de admin.
       */
      if (body.quoteCurrency === base) {
        set.status = 400;
        return {
          error: `${base} es la moneda base de esta empresa: convierte a 1 y no necesita tasa.`,
        };
      }
      if (!Number.isFinite(body.rate) || body.rate <= 0) {
        set.status = 400;
        return { error: 'La tasa debe ser mayor que 0.' };
      }

      const [existing] = await db
        .select({ id: fxRates.id, rate: fxRates.rate })
        .from(fxRates)
        .where(
          and(
            eq(fxRates.companyId, companyId),
            eq(fxRates.baseCurrency, base),
            eq(fxRates.quoteCurrency, body.quoteCurrency),
            eq(fxRates.effectiveDate, body.effectiveDate),
          ),
        );

      /*
       * `fx_rates` NO es un ledger append-only (no está en la lista de CLAUDE.md), así que
       * corregir un dedazo es legítimo: se sobrescribe la fila de esa fecha.
       *
       * Y esto es justamente lo que Jose necesitaba que fuera barato: "algo que hay que ajustar
       * seguido". Lo ya promovido no se toca.
       */
      if (existing) {
        await db
          .update(fxRates)
          .set({ rate: String(body.rate), createdBy: userId })
          .where(eq(fxRates.id, existing.id));
        return { id: existing.id, replaced: true, appliesRetroactively: false };
      }

      const [created] = await db
        .insert(fxRates)
        .values({
          companyId,
          baseCurrency: base,
          quoteCurrency: body.quoteCurrency,
          rate: String(body.rate),
          effectiveDate: body.effectiveDate,
          // El `users.id` del admin que la puso. La ruta de admin guarda acá el `staff.id`; la
          // columna no tiene FK justamente porque sirve a los dos orígenes.
          createdBy: userId,
        })
        .returning({ id: fxRates.id });

      set.status = 201;
      return { id: created!.id, replaced: false, appliesRetroactively: false };
    },
    {
      body: t.Object({
        quoteCurrency: t.Union([t.Literal('GTQ'), t.Literal('USD')]),
        rate: t.Number(),
        // date-only, no timestamp: la vigencia es por día (data model §4.10).
        effectiveDate: t.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}$' }),
      }),
    },
  );
