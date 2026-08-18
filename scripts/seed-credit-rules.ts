import { eq } from 'drizzle-orm';
import { db, sql } from '@/db/client';
import { creditRules } from '@/db/schema';

/**
 * Siembra las reglas de crédito v1 en una instalación que no las tiene — CU-868kt44xm.
 *
 * ═══ EL BUG ═══
 *
 * Macha reportó que el saldo de créditos "se queda fijo en 250" y no baja al consumir.
 * Verificado contra producción, y la causa **no está en el código**:
 *
 *   · `credit_rules` está **VACÍA** en producción;
 *   · `credit_transactions` tiene 21 filas y **ni un solo débito** — solo asignaciones
 *     mensuales y top-ups;
 *   · y sin embargo hay cientos de llamadas de IA registradas en `ai_usage_events`.
 *
 * El motor de débito funciona. Lo que pasa es que cada acción hace
 * `getActiveCreditRule(db, kind)` y, **sin regla activa, no cobra nada** — que es el
 * comportamiento diseñado y está documentado en cada llamador ("sin regla activa la acción
 * no cuesta"). Nadie sembró las reglas: `scripts/seed.ts` las crea, pero ese script además
 * inserta una empresa demo, plantillas de industria y datos de ejemplo, así que **no se
 * puede correr contra producción**.
 *
 * De ahí este script: hace SOLO las reglas, y es seguro de correr sobre datos reales.
 *
 * ═══ LA CONSECUENCIA QUE NO ESTÁ EN EL TICKET ═══
 *
 * Sin reglas no solo falta el descuento: **el bloqueo duro por saldo insuficiente tampoco
 * corre**. Cada endpoint de IA chequea el saldo únicamente si hay regla
 * (`if (creditRule) { ... balance < required ... }`). O sea que hoy una empresa con saldo
 * cero puede consumir Claude sin tope, y lo único que la acota es el rate limiting.
 *
 * Eso es gasto real contra la cuenta de Anthropic, y es la razón por la que esto se
 * arregla ahora y no cuando se empiece a facturar.
 *
 * ═══ POR QUÉ ES UN SCRIPT Y NO UNA MIGRACIÓN ═══
 *
 * CLAUDE.md lo pide explícito: "Data/seed migrations run as separate manual scripts —
 * never mix them". Una migración de esquema corre sola en cada deploy; sembrar datos de
 * negocio en producción es una decisión que alguien toma una vez, mirando.
 *
 * ═══ IDEMPOTENTE, Y ESO IMPORTA ═══
 *
 * Solo inserta la regla de una acción que **no tiene ninguna**. Nunca toca una existente:
 * si alguien ya ajustó los valores desde /admin, volver a correr esto no se los pisa. Y
 * `credit_rules` es versionada — las correcciones son versiones nuevas, no ediciones—, así
 * que insertar a ciegas crearía una v1 duplicada y rompería el índice único
 * `(action_kind, version)`.
 *
 * Uso:
 *   DATABASE_URL=<...> bun run scripts/seed-credit-rules.ts
 */

/**
 * Valores PROVISIONALES, los mismos de `scripts/seed.ts` (decisión de Jose, CU-868kfv97x):
 * holgados a propósito para que nadie choque contra el límite durante las pruebas. Ninguno
 * es final — se definen con datos reales de costo. Se copian en vez de importarse porque
 * aquel script arrastra la empresa demo entera al importarlo.
 */
const REGLAS_V1 = [
  {
    actionKind: 'excel' as const,
    ruleType: 'variable' as const,
    creditsPerUnit: '1',
    unit: 'batch' as const,
  },
  { actionKind: 'chat' as const, ruleType: 'fixed' as const, creditsPerUnit: '1', unit: null },
  { actionKind: 'insight' as const, ruleType: 'fixed' as const, creditsPerUnit: '1', unit: null },
  {
    actionKind: 'report_generation' as const,
    ruleType: 'fixed' as const,
    creditsPerUnit: '2',
    unit: null,
  },
];

async function main(): Promise<void> {
  let sembradas = 0;

  for (const regla of REGLAS_V1) {
    const existentes = await db
      .select({ id: creditRules.id, version: creditRules.version, active: creditRules.active })
      .from(creditRules)
      .where(eq(creditRules.actionKind, regla.actionKind));

    if (existentes.length > 0) {
      const activa = existentes.find((r) => r.active);
      console.log(
        `· ${regla.actionKind}: ya tiene ${existentes.length} regla(s)` +
          (activa
            ? ` (v${activa.version} activa) — no se toca`
            : ' pero NINGUNA activa — revisar a mano'),
      );
      continue;
    }

    await db.insert(creditRules).values({ ...regla, version: 1, active: true });
    sembradas++;
    console.log(`✓ ${regla.actionKind}: sembrada v1 = ${regla.creditsPerUnit} crédito(s)`);
  }

  console.log(
    sembradas === 0
      ? '\nNada que sembrar: las cuatro acciones ya tenían regla.'
      : `\n${sembradas} regla(s) sembrada(s). A partir de ahora el consumo DEBITA y el bloqueo por saldo insuficiente vuelve a aplicar.`,
  );
}

await main();
await sql.end();
