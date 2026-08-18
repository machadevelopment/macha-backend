// Catálogo inicial de reglas de alerta — decisión CU-868kfv993 (2026-07-24). Jose
// confirmó: 6 reglas deterministas (sin IA); las 3 que afectan liquidez notifican por
// email de inmediato, las otras 3 se acumulan y se resumen en el reporte periódico
// (evita que el cliente reciba varios correos el mismo día y deje de abrirlos).
//
// Reglas de implementación confirmadas (para T49, el motor de evaluación — no
// implementadas aquí):
// - Todos los umbrales son configurables POR EMPRESA, nunca globales — este catálogo
//   es solo el default que la futura provisión de empresa (F7) siembra en `alert_rules`.
// - Evaluación tras cada job de Excel exitoso, después de la promoción atómica.
// - Control de repetición: una misma regla sobre el mismo objeto no vuelve a notificar
//   en 7 días, aunque siga cumpliéndose. Historial completo en `alert_events`, incluidas
//   las que no notificaron por el control de repetición.
// - `spend_out_of_range` requiere al menos 3 meses de historia cargada; con menos,
//   la regla queda inactiva y no dispara falsos positivos.
//
// Umbrales REALES aprobados por Jose (confirmados sin cambios en su revisión final;
// la API de ClickUp había devuelto la tabla vacía la primera vez, ya se corrigió).
/**
 * Unidad del umbral. Estaba solo en comentarios sueltos ("// días", "// %") y eso costó
 * dos cosas: el backoffice mostraba números sin unidad (CU-868khvzqn) y nada validaba
 * que un porcentaje estuviera entre 0 y 100. Al hacerla un dato, las dos se resuelven en
 * el mismo sitio y no pueden divergir del umbral que describen.
 */
export type AlertThresholdUnit = 'percent' | 'days';

export type AlertCatalogEntry = {
  ruleKey: string;
  label: string;
  defaultThreshold: number;
  unit: AlertThresholdUnit;
  notifyImmediately: boolean;
  notes: string;
};

export const alertCatalog: AlertCatalogEntry[] = [
  {
    ruleKey: 'ar_overdue',
    label: 'Cobro vencido',
    defaultThreshold: 60,
    unit: 'days',
    notifyImmediately: true,
    notes: 'Factura por cobrar que pasa N días de su vencimiento (invoices.due_date).',
  },
  {
    ruleKey: 'portfolio_concentration',
    label: 'Concentración de cartera',
    defaultThreshold: 25,
    unit: 'percent',
    notifyImmediately: true,
    notes: 'Un solo cliente concentra más del % de lo que te deben (AR abierta).',
  },
  {
    ruleKey: 'revenue_drop',
    label: 'Caída de ingresos MoM',
    defaultThreshold: 15,
    unit: 'percent',
    notifyImmediately: true,
    // CU-868kt94an: "último mes CERRADO", no "el mes en curso". La descripción vieja
    // decía "ingresos del mes" y era literal — comparaba un mes a medio transcurrir
    // contra tres completos, y 18 de las 25 alertas de esta regla en producción
    // marcaban exactamente 100 %. Ver el comentario largo en `evalRevenueDrop`.
    notes: 'Ingresos del último mes cerrado contra el promedio de los 3 meses anteriores a ese.',
  },
  {
    ruleKey: 'margin_drop',
    label: 'Margen bajo',
    // CU-868kh8y58 — NO CAMBIAR a un valor "de neto". Este 25% está calibrado sobre
    // MARGEN BRUTO (`revenue - cogs`, sin restar opex), que es la definición cerrada
    // del producto: ver lib/margin.ts y PRD.md §08. Un umbral pensado para margen neto
    // sería mucho más bajo, y aplicarlo al bruto dejaría la alerta muda justo en las
    // empresas que peor están.
    defaultThreshold: 25,
    unit: 'percent',
    notifyImmediately: false,
    notes: 'Margen bruto del período (ingresos − costo directo) por debajo del umbral.',
  },
  {
    ruleKey: 'spend_out_of_range',
    label: 'Gasto fuera de rango',
    defaultThreshold: 40,
    unit: 'percent',
    notifyImmediately: false,
    notes:
      'Reemplaza "gasto anómalo" (no determinista). Una categoría de costo supera su ' +
      'promedio de 3 meses en más del %; requiere >=3 meses de historia cargada, si no ' +
      'la regla queda inactiva.',
  },
  {
    ruleKey: 'low_credit_balance',
    label: 'Saldo de créditos bajo',
    defaultThreshold: 20,
    unit: 'percent',
    notifyImmediately: false,
    notes: 'Créditos restantes por debajo del % de la asignación mensual.',
  },
];
