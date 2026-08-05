import { describe, expect, test } from 'bun:test';
import { alertCatalog } from './alert-catalog';

/**
 * El catálogo es una decisión de producto cerrada por Jose (CU-868kfv993), no una
 * constante cualquiera: sus umbrales son los que se siembran en cada empresa nueva y las
 * tres reglas de "dato crítico" definen qué manda correo inmediato. Estas pruebas fijan
 * lo acordado para que una edición distraída no lo cambie sin que nadie se entere.
 */
describe('catálogo de alertas (CU-868kfv993)', () => {
  test('son las 6 reglas aprobadas', () => {
    expect(alertCatalog.map((e) => e.ruleKey)).toEqual([
      'ar_overdue',
      'portfolio_concentration',
      'revenue_drop',
      'margin_drop',
      'spend_out_of_range',
      'low_credit_balance',
    ]);
  });

  test('los umbrales default son los que aprobó Jose', () => {
    const porClave = Object.fromEntries(alertCatalog.map((e) => [e.ruleKey, e.defaultThreshold]));
    expect(porClave).toEqual({
      ar_overdue: 60,
      portfolio_concentration: 25,
      revenue_drop: 15,
      margin_drop: 25,
      spend_out_of_range: 40,
      low_credit_balance: 20,
    });
  });

  /**
   * "Dato crítico" = las tres que afectan liquidez. Las otras tres se acumulan y se
   * resumen en el reporte, para que el cliente no reciba cinco correos el mismo día y
   * deje de abrirlos.
   */
  test('solo las tres reglas de liquidez notifican de inmediato', () => {
    expect(alertCatalog.filter((e) => e.notifyImmediately).map((e) => e.ruleKey)).toEqual([
      'ar_overdue',
      'portfolio_concentration',
      'revenue_drop',
    ]);
  });

  test('cada regla declara su unidad — sin ella el umbral es un número ambiguo', () => {
    for (const entry of alertCatalog) {
      expect(['percent', 'days']).toContain(entry.unit);
    }
    // La única en días; el resto son porcentajes.
    expect(alertCatalog.filter((e) => e.unit === 'days').map((e) => e.ruleKey)).toEqual([
      'ar_overdue',
    ]);
  });
});
