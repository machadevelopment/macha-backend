import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { SETTINGS_DEFAULTS, SETTINGS_KEYS } from '@/lib/settings';
import { creditsConfig } from '@/config/credits';

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════
 * EL PANEL Y EL SISTEMA NO PUEDEN MOSTRAR NÚMEROS DISTINTOS
 * ═══════════════════════════════════════════════════════════════════════════════════════
 *
 * Jose reportó (2026-08-20) que "Parámetros de negocio" está en blanco. Verificado contra la
 * base de PRODUCCIÓN: `platform_settings` tiene 0 filas, así que el sistema corre con los
 * fallbacks de cada `getPlatformSetting` y el panel mostraba una lista vacía — ocultando una
 * configuración que sí está en efecto.
 *
 * `SETTINGS_DEFAULTS` es lo que ahora responde "¿qué valor está en efecto?" cuando no hay fila.
 * Su único riesgo es DESINCRONIZARSE del fallback que pasa el llamador real: ahí el panel
 * mostraría un número y el sistema usaría otro, en una pantalla donde se edita el precio del
 * crédito. Es el peor resultado posible de una pantalla de configuración, y no falla nada.
 */

const RAIZ = new URL('../..', import.meta.url);
const leer = (ruta: string) => readFileSync(new URL(ruta, RAIZ), 'utf8');

describe('SETTINGS_DEFAULTS cubre lo que el panel tiene que mostrar', () => {
  test('hay un default por cada clave declarada', () => {
    /*
     * Si alguien agrega una clave a `SETTINGS_KEYS` y no a este mapa, el parámetro nuevo
     * desaparece del panel en cualquier entorno sin la fila sembrada — que es exactamente el
     * bug que este trabajo vino a arreglar, un parámetro más tarde.
     */
    for (const clave of Object.values(SETTINGS_KEYS)) {
      expect(Object.keys(SETTINGS_DEFAULTS)).toContain(clave);
    }
  });

  test('ningún default es undefined', () => {
    // Un `undefined` se serializa fuera del JSON y el parámetro vuelve a no aparecer.
    for (const [clave, fn] of Object.entries(SETTINGS_DEFAULTS)) {
      expect(fn(), clave).toBeDefined();
    }
  });
});

describe('los defaults coinciden con lo que el sistema usa de verdad', () => {
  test('la asignación mensual es la misma que consulta `lib/alerts`', () => {
    /*
     * `alerts.ts` pasa `creditsConfig.monthlyAllotment` como fallback. Si acá se escribiera un
     * literal, cambiar `CREDIT_MONTHLY_ALLOTMENT` en Railway movería el valor real y dejaría el
     * del panel congelado.
     */
    expect(SETTINGS_DEFAULTS[SETTINGS_KEYS.creditMonthlyAllotment]!()).toBe(
      creditsConfig.monthlyAllotment,
    );
    expect(leer('src/lib/alerts.ts')).toContain('creditsConfig.monthlyAllotment');
  });

  test('el grant inicial cae al mismo número que consulta `lib/credits`', () => {
    expect(SETTINGS_DEFAULTS[SETTINGS_KEYS.creditInitialGrant]!()).toBe(
      creditsConfig.monthlyAllotment,
    );
    expect(leer('src/lib/credits.ts')).toContain('creditsConfig.monthlyAllotment');
  });

  test('el precio por crédito es el mismo literal que usa el checkout', () => {
    /*
     * `credits-topup.ts` pasa `10` a mano. Es el único fallback literal del conjunto, y por eso
     * el que más fácil se separa: acá se fija que sigan siendo el mismo número.
     */
    expect(SETTINGS_DEFAULTS[SETTINGS_KEYS.creditPriceUsdCents]!()).toBe(10);
    expect(leer('src/modules/billing/credits-topup.ts')).toMatch(/creditPriceUsdCents,\s*10\s*\)/);
  });
});

describe('la clave que no está conectada a nada', () => {
  test('`credit_to_tokens_ratio` sigue sin ser consumida — queda documentado, no arreglado', () => {
    /*
     * ═══ ESTO NO ES UN TEST DE COMPORTAMIENTO: ES UN RECORDATORIO CON DIENTES ═══
     *
     * La clave está declarada desde CU-868kfvafy como "configurable desde el panel, nunca en
     * código", y buscada en todo `src` NADIE la lee de `platform_settings`. Un operador la edita,
     * ve que se guardó, y el sistema sigue igual.
     *
     * No se arregló acá porque conectarla es una decisión de producto —dónde se aplica la
     * conversión crédito↔token—, no un ajuste de panel. Pero si algún día alguien la conecta,
     * este test falla y le avisa que borre el comentario de advertencia que hay en
     * `SETTINGS_DEFAULTS`, para que no quede una advertencia falsa: nada envejece peor que un
     * "cuidado, esto no funciona" sobre algo que ya funciona.
     */
    const settings = leer('src/lib/settings.ts');
    const consumidores = [
      leer('src/lib/credits.ts'),
      leer('src/lib/alerts.ts'),
      leer('src/modules/insights/index.ts'),
      leer('src/modules/billing/credits-topup.ts'),
    ].join('\n');

    expect(consumidores).not.toContain('creditToTokensRatio');
    // Y la advertencia sigue puesta mientras eso sea cierto.
    expect(settings).toContain('ESTA CLAVE NO LA CONSUME NADIE');
  });
});
