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
export type AlertCatalogEntry = {
  ruleKey: string;
  label: string;
  /** Placeholder — ver nota arriba. Unidad según la regla (%, días). */
  defaultThreshold: number;
  notifyImmediately: boolean;
  notes: string;
};

export const alertCatalog: AlertCatalogEntry[] = [
  {
    ruleKey: 'ar_overdue',
    label: 'Cobro vencido',
    defaultThreshold: 60, // días
    notifyImmediately: true,
    notes: 'Factura por cobrar que pasa N días de su vencimiento (invoices.due_date).',
  },
  {
    ruleKey: 'portfolio_concentration',
    label: 'Concentración de cartera',
    defaultThreshold: 25, // % de AR en un solo counterparty
    notifyImmediately: true,
    notes: 'Un solo cliente concentra más del % de lo que te deben (AR abierta).',
  },
  {
    ruleKey: 'revenue_drop',
    label: 'Caída de ingresos MoM',
    defaultThreshold: 15, // % caída vs. promedio de los 3 meses anteriores
    notifyImmediately: true,
    notes: 'Ingresos del mes contra el promedio de los 3 meses anteriores.',
  },
  {
    ruleKey: 'margin_drop',
    label: 'Margen bajo',
    defaultThreshold: 25, // % margen mínimo
    notifyImmediately: false,
    notes: 'Margen bruto del período por debajo del umbral.',
  },
  {
    ruleKey: 'spend_out_of_range',
    label: 'Gasto fuera de rango',
    defaultThreshold: 40, // % desviación vs. promedio móvil de 3 meses
    notifyImmediately: false,
    notes:
      'Reemplaza "gasto anómalo" (no determinista). Una categoría de costo supera su ' +
      'promedio de 3 meses en más del %; requiere >=3 meses de historia cargada, si no ' +
      'la regla queda inactiva.',
  },
  {
    ruleKey: 'low_credit_balance',
    label: 'Saldo de créditos bajo',
    defaultThreshold: 20, // % de la asignación mensual restante
    notifyImmediately: false,
    notes: 'Créditos restantes por debajo del % de la asignación mensual.',
  },
];
