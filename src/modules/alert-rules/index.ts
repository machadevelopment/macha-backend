import { Elysia, t } from 'elysia';
import { and, eq } from 'drizzle-orm';
import { tenantDerive } from '@/guards/tenant.derive';
import { assertClientCapability } from '@/guards/require-capability';
import { enforceTokenBucket } from '@/lib/rate-limit';
import { alertCatalog, type AlertCatalogEntry } from '@/config/alert-catalog';
import { alertRules } from '@/db/schema';

/**
 * CU-868kh8pwv, capacidad `configure_alerts`: el cliente (owner y admin) ajusta sus
 * propios umbrales de alerta sin depender de Macha.
 *
 * Decisión de Jose (2026-07-28): entra al MVP porque es configuración operativa, no un
 * evento de onboarding — "un dueño va a querer subir su umbral de cartera vencida de 60
 * a 90 días un martes cualquiera, porque así trabaja su negocio". Hasta ahora los
 * umbrales solo eran editables desde `/admin/companies/:id/alert-rules`, o sea
 * escribiéndole a Macha.
 *
 * ES EL MISMO DATO QUE EDITA EL BACKOFFICE, no una copia: `alert_rules` ya es por
 * empresa desde F0 y la fila es una sola. Lo que cambia es la puerta y quién la abre —
 * aquí `tenantDerive` + `configure_alerts` (owner/admin), allá `adminGuard` +
 * `manage_companies` (super_admin).
 *
 * QUÉ NO PUEDE TOCAR EL CLIENTE, y por qué:
 *   - `notify_immediately`. Cuáles son las tres reglas de "dato crítico" que mandan
 *     correo inmediato es una decisión de producto cerrada por Jose (CU-868kfv993), no
 *     una preferencia por empresa. Dejarla editable convertiría el resto del catálogo en
 *     correo inmediato y el cliente acabaría ignorando todos los avisos, que es
 *     exactamente lo que esa decisión evita.
 *   - `rule_key`. El catálogo es fijo y determinista (sin IA). Solo se ajusta el umbral
 *     y el encendido de reglas que ya existen; no se inventan reglas nuevas.
 *
 * Sin `admin_audit_log`: esa bitácora existe para cuando personal de Macha toca datos de
 * un cliente (CU-868kfvagj). Un dueño ajustando su propio umbral no es esa situación.
 */

const CATALOG_BY_KEY = new Map<string, AlertCatalogEntry>(alertCatalog.map((e) => [e.ruleKey, e]));

/**
 * Validación por unidad. Un porcentaje fuera de 0–100 o un plazo en días fraccionario no
 * son "umbrales raros": son reglas que nunca dispararán o que dispararán siempre, y el
 * cliente no tendría cómo saberlo — la alerta simplemente dejaría de servir en silencio.
 */
function validateThreshold(entry: AlertCatalogEntry, value: number): string | null {
  if (!Number.isFinite(value)) return 'El umbral debe ser un número.';
  if (entry.unit === 'percent') {
    if (value <= 0 || value > 100) return 'Un umbral en porcentaje debe estar entre 0 y 100.';
    return null;
  }
  if (!Number.isInteger(value) || value < 1) {
    return 'Un umbral en días debe ser un número entero de al menos 1.';
  }
  return null;
}

export const clientAlertRules = new Elysia({ prefix: '/alert-rules' })
  .use(tenantDerive)
  .get('/', async ({ companyId, role, set, db }) => {
    assertClientCapability(role, 'configure_alerts', set);

    const limited = await enforceTokenBucket('read', companyId, set, 'GET /alert-rules');
    if (limited) return limited;

    const rows = await db.select().from(alertRules).where(eq(alertRules.companyId, companyId));

    // `label` y `unit` viajan desde el catálogo: sin la unidad, la pantalla muestra un
    // "25" que lo mismo son días que por ciento, que es el hueco que reportó
    // CU-868khvzqn en el backoffice. El cliente no puede derivarla de ningún otro campo.
    return {
      rules: rows.map((r) => {
        const entry = CATALOG_BY_KEY.get(r.ruleKey);
        return {
          ruleKey: r.ruleKey,
          label: entry?.label ?? r.ruleKey,
          unit: entry?.unit ?? null,
          threshold: Number(r.threshold),
          enabled: r.enabled,
          // Informativo: el cliente ve cuáles avisan por correo al instante, aunque no
          // pueda cambiarlo.
          notifyImmediately: r.notifyImmediately,
        };
      }),
    };
  })
  .patch(
    '/:ruleKey',
    async ({ companyId, role, params, body, set, db }) => {
      assertClientCapability(role, 'configure_alerts', set);

      const entry = CATALOG_BY_KEY.get(params.ruleKey);
      if (!entry) {
        set.status = 404;
        return { error: `La regla '${params.ruleKey}' no existe en el catálogo.` };
      }

      if (body.threshold !== undefined) {
        const problema = validateThreshold(entry, body.threshold);
        if (problema) {
          set.status = 422;
          return { error: problema };
        }
      }

      // `company_id` explícito además del GUC: RLS es el backstop, no el filtro.
      const [before] = await db
        .select()
        .from(alertRules)
        .where(and(eq(alertRules.companyId, companyId), eq(alertRules.ruleKey, params.ruleKey)));
      if (!before) {
        // La regla está en el catálogo pero la empresa no tiene su fila: empresas
        // creadas antes de que `seedDefaultAlertRules` corriera en el alta.
        set.status = 404;
        return { error: `La empresa no tiene configurada la regla '${params.ruleKey}'.` };
      }

      await db
        .update(alertRules)
        .set({
          threshold: body.threshold !== undefined ? String(body.threshold) : before.threshold,
          enabled: body.enabled ?? before.enabled,
          updatedAt: new Date(),
        })
        .where(and(eq(alertRules.companyId, companyId), eq(alertRules.ruleKey, params.ruleKey)));

      return {
        ruleKey: params.ruleKey,
        label: entry.label,
        unit: entry.unit,
        threshold: body.threshold ?? Number(before.threshold),
        enabled: body.enabled ?? before.enabled,
      };
    },
    {
      // `notifyImmediately` NO está aquí a propósito — ver la cabecera del módulo.
      body: t.Object({
        threshold: t.Optional(t.Number()),
        enabled: t.Optional(t.Boolean()),
      }),
    },
  );
