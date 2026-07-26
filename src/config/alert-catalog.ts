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
// PLACEHOLDER: los umbrales numéricos de Jose no llegaron (tabla vacía en su comentario
// de ClickUp) y el PRD tampoco los tiene (el ticket original solo usaba letras X/Y/Z
// como placeholder de redacción — nunca hubo cifra real documentada en ningún lado).
// Los valores de abajo son una propuesta razonable, NO una cifra confirmada; ajustar
// cuando Macha/Jose den los números reales — el mecanismo no se bloquea por esto.
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
    defaultThreshold: 30, // días
    notifyImmediately: true,
    notes: 'Días de vencimiento de una factura por cobrar (invoices.due_date).',
  },
  {
    ruleKey: 'portfolio_concentration',
    label: 'Concentración de cartera',
    defaultThreshold: 40, // % de AR en un solo counterparty
    notifyImmediately: true,
    notes: '% de cuentas por cobrar abiertas concentradas en un solo counterparty.',
  },
  {
    ruleKey: 'revenue_drop',
    label: 'Caída de ingresos MoM',
    defaultThreshold: 15, // % caída mes contra mes
    notifyImmediately: true,
    notes: 'Caída porcentual de revenue del mes vs. el mes anterior.',
  },
  {
    ruleKey: 'margin_drop',
    label: 'Margen bruto bajo',
    defaultThreshold: 20, // % margen mínimo
    notifyImmediately: false,
    notes: 'Margen bruto (revenue - cogs) / revenue por debajo del umbral.',
  },
  {
    ruleKey: 'spend_out_of_range',
    label: 'Gasto fuera de rango',
    defaultThreshold: 40, // % desviación vs. promedio móvil de 3 meses
    notifyImmediately: false,
    notes:
      'Reemplaza "gasto anómalo" (no determinista). Desviación vs. promedio móvil de 3 ' +
      'meses de la misma categoría; requiere >=3 meses de historia cargada, si no la ' +
      'regla queda inactiva.',
  },
  {
    ruleKey: 'low_credit_balance',
    label: 'Saldo de créditos bajo',
    defaultThreshold: 10, // % del allotment mensual restante
    notifyImmediately: false,
    notes: '% del allotment mensual de créditos de insight restante.',
  },
];
