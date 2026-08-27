import { and, asc, desc, eq, lte } from 'drizzle-orm';
import { t } from 'elysia';
import type { DB } from '@/db/client';
import { fxRates } from '@/db/schema';

/**
 * CU-868kjc6h1: catálogo de tasas de cambio por empresa. Hasta este ticket NADA en el
 * repositorio escribía en `fx_rates` — la tabla existía, con RLS e índices, y estaba
 * permanentemente vacía. `promotion.ts` la leía y, al no encontrar fila, tiraba el
 * upload COMPLETO (la promoción es atómica): una sola fila en USD en una empresa con
 * base GTQ dejaba fuera hasta las filas que sí estaban en GTQ.
 *
 * Este módulo concentra las tres cosas que antes vivían sueltas dentro de la promoción:
 * qué moneda puede necesitar tasa, cómo se resuelve la vigente, y qué se le dice a
 * quien tiene que arreglarlo.
 *
 * RETROACTIVIDAD (criterio 5 del ticket): registrar una tasa NO recalcula nada ya
 * promovido. `transactions`/`invoices`/`bills` congelan `fx_rate` + `fx_rate_date` por
 * fila en el momento de promover (data model §3), y esa foto es justamente lo que hace
 * auditable una cifra histórica. Una tasa nueva solo afecta a lo que se promueva
 * después. Corregir una conversión ya escrita es revertir la carga
 * (`POST /documents/:id/revert`) y volver a promoverla, no editar el pasado.
 */

export type Currency = 'GTQ' | 'USD';

export const CURRENCIES: readonly Currency[] = ['GTQ', 'USD'] as const;

/** La otra moneda del par soportado (PRD §8: el producto solo maneja GTQ y USD). */
export function counterCurrency(base: Currency): Currency {
  return base === 'GTQ' ? 'USD' : 'GTQ';
}

export type FxRateHit = { rate: number; effectiveDate: string };

/**
 * Tasa aplicable a una fecha. Preferencia: la más reciente que NO sea posterior a la fecha
 * (data model §4.10). La moneda base siempre resuelve a 1 sin necesidad de fila.
 *
 * SI NINGUNA PRECEDE A LA FECHA, CAE A LA MÁS ANTIGUA DISPONIBLE en vez de devolver `null`.
 * Eso es nuevo (2026-08-07) y arregla un footgun con dientes: el operador registraba una tasa
 * siguiendo al pie de la letra el mensaje de la fila marcada, volvía a procesar… y no se
 * desbloqueaba nada, porque su libro tenía movimientos de 2025 y la tasa que acababa de
 * registrar era de hoy. Para que funcionara tenía que adivinar que hacía falta retrofecharla
 * antes del movimiento más antiguo del archivo — algo que el mensaje no decía y que no hay
 * forma de deducir desde la pantalla. Medido en producción el 2026-08-06: 617 filas retenidas
 * por falta de tasa, sobre 228 fechas distintas desde 2025-01-01.
 *
 * ES UNA APROXIMACIÓN, Y ESTÁ ELEGIDA A CONCIENCIA. Convertir un movimiento de enero de 2025
 * con la tasa de agosto de 2026 no da la cifra exacta. La alternativa REAL no era "la cifra
 * exacta" sino "la fila no entra nunca", que deja al cliente con un dashboard incompleto y sin
 * saber por qué. Y la aproximación no queda escondida: cada fila de negocio congela
 * `fx_rate` + `fx_rate_date`, así que se ve exactamente qué tasa se aplicó y de qué fecha era.
 * Quien quiera la cifra exacta registra la tasa con la vigencia correcta, revierte la carga y
 * la vuelve a promover.
 *
 * Lo que NO se hace es inventar una tasa: sin ninguna fila para el par, sigue devolviendo
 * `null` y la fila se retiene. Multiplicar por 1 un monto en otra moneda escribiría dinero
 * incorrecto en silencio, que es peor que retener la fila.
 */
export async function findFxRate(
  db: DB,
  companyId: string,
  base: Currency,
  quote: Currency,
  onOrBefore: string,
): Promise<FxRateHit | null> {
  if (quote === base) return { rate: 1, effectiveDate: onOrBefore };

  const delPar = and(
    eq(fxRates.companyId, companyId),
    eq(fxRates.baseCurrency, base),
    eq(fxRates.quoteCurrency, quote),
  );

  const [vigente] = await db
    .select({ rate: fxRates.rate, effectiveDate: fxRates.effectiveDate })
    .from(fxRates)
    .where(and(delPar, lte(fxRates.effectiveDate, onOrBefore)))
    .orderBy(desc(fxRates.effectiveDate))
    .limit(1);

  if (vigente) {
    return { rate: Number(vigente.rate), effectiveDate: vigente.effectiveDate };
  }

  // Segunda query y no un `OR` en la primera: son dos preguntas con orden distinto (la más
  // reciente hacia atrás, la más antigua hacia adelante) y la segunda solo corre cuando la
  // primera no encontró nada, que es el caso raro.
  const [masAntigua] = await db
    .select({ rate: fxRates.rate, effectiveDate: fxRates.effectiveDate })
    .from(fxRates)
    .where(delPar)
    .orderBy(asc(fxRates.effectiveDate))
    .limit(1);

  return masAntigua
    ? { rate: Number(masAntigua.rate), effectiveDate: masAntigua.effectiveDate }
    : null;
}

/**
 * Todas las tasas del par, de más reciente a más antigua. La ingesta clasifica cientos
 * de filas por lote y cada una tiene su propia fecha: resolverlas con una query por
 * fila serían cientos de round-trips dentro de la transacción del lote. El catálogo de
 * una empresa es de decenas de filas como mucho (lo mantiene un humano), así que cabe
 * entero en memoria.
 */
export async function loadFxCatalog(
  db: DB,
  companyId: string,
  base: Currency,
  quote: Currency,
): Promise<FxRateHit[]> {
  if (quote === base) return [];

  const rows = await db
    .select({ rate: fxRates.rate, effectiveDate: fxRates.effectiveDate })
    .from(fxRates)
    .where(
      and(
        eq(fxRates.companyId, companyId),
        eq(fxRates.baseCurrency, base),
        eq(fxRates.quoteCurrency, quote),
      ),
    )
    .orderBy(desc(fxRates.effectiveDate));

  return rows.map((r) => ({ rate: Number(r.rate), effectiveDate: r.effectiveDate }));
}

/**
 * Misma semántica que `findFxRate` pero contra un catálogo ya cargado (ordenado desc),
 * incluida la caída a la tasa más antigua cuando ninguna precede a la fecha.
 *
 * Tiene que coincidir con `findFxRate` o el producto se contradice consigo mismo: esta
 * función decide si la fila se MARCA durante la ingesta, y `findFxRate` decide si se puede
 * CONVERTIR al promover. Si una encontrara tasa y la otra no, o se retendría una fila que sí
 * se podía convertir, o la promoción lanzaría sobre una fila que la ingesta dio por buena
 * —y la promoción es atómica, así que se llevaría por delante al resto del lote.
 */
export function resolveFromCatalog(catalog: FxRateHit[], onOrBefore: string): FxRateHit | null {
  const vigente = catalog.find((r) => r.effectiveDate <= onOrBefore);
  if (vigente) return vigente;
  // Ordenado desc, así que la última es la más antigua. `at(-1)` sobre un catálogo vacío es
  // `undefined`, que es exactamente el caso "no hay ninguna tasa para el par".
  return catalog.at(-1) ?? null;
}

/**
 * El mensaje que ve un humano cuando falta la tasa. Antes era
 * `No fx_rate for company <uuid>: USD->GTQ on or before 2026-07-01` — técnicamente
 * exacto y operativamente inútil: no decía qué hacer ni dónde. El `company_id` sale
 * (quien lee el monitoreo de uploads ya está mirando la fila de esa empresa) y entra
 * la acción concreta (criterio 3).
 *
 * Ya NO pide una fecha de vigencia concreta, y esa frase era el problema: decía "con una
 * fecha igual o anterior a esa", lo cual obligaba a mirar el movimiento más antiguo del
 * archivo y retrofechar. Desde que la resolución cae a la tasa más antigua disponible
 * (2026-08-07), registrar UNA tasa cualquiera alcanza para que el archivo entero se
 * convierta — así que el mensaje pide lo mínimo que de verdad hace falta.
 */
export function missingFxRateMessage(params: {
  quote: Currency;
  base: Currency;
  onOrBefore: string;
}): string {
  return (
    `Esta empresa no tiene ninguna tasa de cambio ${params.quote}→${params.base} registrada, ` +
    `así que no se pudo convertir un movimiento del ${params.onOrBefore}. Registra una en el ` +
    `panel admin (Empresa › Tasas de cambio) —con cualquier fecha de vigencia, se usa la más ` +
    `cercana disponible— y vuelve a procesar la carga.`
  );
}

/** Prefijo de `staging_rows.flag_reason` para una fila que no se puede convertir. */
export const MISSING_FX_FLAG = 'missing_fx_rate';

export function missingFxFlagReason(quote: Currency, onOrBefore: string): string {
  return `${MISSING_FX_FLAG}:${quote}:${onOrBefore}`;
}

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * UNA TASA TIENE QUE SER ESTRICTAMENTE POSITIVA, Y EL ESQUEMA ES DONDE SE DECIDE
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *
 * Las dos rutas que escriben en `fx_rates` —la del cliente y la de admin— validaban con
 * `t.Number()` a secas, así que **una tasa de 0 se aceptaba y se guardaba**. El daño no es
 * teórico y no deja rastro:
 *
 *   · la ingesta hace `amount_base = originalAmount * fxRate` (`computeAmountBase`), o sea que
 *     con 0 **toda fila en la otra moneda se promueve con importe cero**, sin marcarse y sin
 *     error: el cliente ve desaparecer la parte en dólares de su contabilidad;
 *   · una tasa negativa es peor, porque invierte el signo del movimiento;
 *   · y la lente de vista del frontend DIVIDE por la tasa, así que un 0 es una división por
 *     cero en la pantalla principal.
 *
 * Vive acá y no en cada ruta por el mismo motivo que el orden de las redes del pool vive en un
 * solo archivo: dos copias de una regla en dos módulos no se pueden mantener de acuerdo. Es un
 * esquema y no una función porque las dos rutas validan con TypeBox — una función suelta sería
 * un segundo mecanismo que alguien tiene que acordarse de llamar.
 */
export const ESQUEMA_TASA = t.Number({ exclusiveMinimum: 0 });
