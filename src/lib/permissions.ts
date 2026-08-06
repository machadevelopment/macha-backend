// Matrices de permisos aprobadas por Jose Bustamante en CU-868kfv96c (2026-07-24).
// Roles en Postgres, nunca en el RBAC de WorkOS. La autorización se resuelve
// server-side; esto es la única fuente de verdad, la UI solo la refleja.

export type ClientRole = 'owner' | 'admin' | 'member';
export type StaffTier = 'staff' | 'super_admin';

// Eje 1 — roles dentro de la empresa cliente (company_users).
export type ClientCapability =
  | 'view_dashboard_reports'
  | 'chat'
  | 'upload_excel'
  | 'revert_upload'
  | 'edit_send_reports'
  | 'configure_alerts'
  | 'manage_members'
  | 'change_roles'
  | 'billing'
  | 'manage_inventory';

// CU-868kh8pwv — `delete_company` SE RETIRÓ de la matriz (decisión de Jose, 2026-07-28).
//
// No se implementó ni se dejó declarada: no existe un "borrar empresa" en la interfaz
// del cliente, y una capacidad que nadie puede ejercer es deuda, no diseño. Ninguna
// herramienta seria deja que el dueño de una cuenta de pago destruya su empresa y su
// data financiera con un clic.
//
// Lo que la reemplaza es DAR DE BAJA LA SUSCRIPCIÓN: un cambio de estado, no una
// destrucción. La cuenta pasa a `cancelada` —pierde acceso a lo que consume IA— y su
// data se conserva. Eso ya existe como estado de cuenta (activa/mora/cancelada) del
// Módulo 8 y de la decisión de créditos (CU-868kfv97x), así que la capacidad de baja
// vive atada a la suscripción y no a un permiso suelto sobre la empresa. El botón que
// ejerce el owner es "dar de baja mi plan", no "borrar empresa".
//
// El borrado físico —si algún día hace falta, p. ej. por una solicitud legal de
// eliminación de datos— es una operación interna de Macha con confirmación, fuera del
// MVP y fuera de la interfaz del cliente.

// Matriz 1 (aprobada). member sí carga Excel: en una pyme quien sube el archivo
// casi nunca es el dueño. owner siempre tiene todas las capacidades del cliente.
const CLIENT_MATRIX: Record<ClientCapability, ClientRole[]> = {
  view_dashboard_reports: ['owner', 'admin', 'member'],
  chat: ['owner', 'admin', 'member'],
  upload_excel: ['owner', 'admin', 'member'],
  revert_upload: ['owner', 'admin'],
  edit_send_reports: ['owner', 'admin'],
  configure_alerts: ['owner', 'admin'],
  manage_members: ['owner'],
  change_roles: ['owner'],
  billing: ['owner'],
  // Mismo criterio que `upload_excel`, y por la misma razón práctica: en una pyme quien
  // cuenta la mercadería y registra una entrada de bodega casi nunca es el dueño. Dejarlo
  // en owner/admin obligaría a que el dueño transcriba lo que le dictan, que es como se
  // deja de usar la pantalla.
  //
  // Incluye dar de baja un SKU, y eso NO es una excepción olvidada: la baja es lógica
  // (`deleted_at`), el historial de movimientos sobrevive intacto y el ledger es
  // append-only, así que no hay nada que destruir. Una capacidad aparte para marcar una
  // bandera reversible sería control que no controla nada.
  manage_inventory: ['owner', 'admin', 'member'],
};

export function clientCan(role: ClientRole, capability: ClientCapability): boolean {
  return CLIENT_MATRIX[capability].includes(role);
}

// Eje 2 — roles de Macha Internal (staff), namespace /admin/* (separado del guard
// de tenant; la resolución real de identidad staff vive en CU-868kfvaex).
export type StaffCapability =
  | 'view_companies'
  | 'review_flagged_rows'
  | 'view_job_status'
  | 'view_ai_usage_cost'
  | 'topup_credits'
  | 'edit_action_to_credits_ratio'
  | 'edit_credits_to_tokens_param'
  | 'manage_plans_and_templates'
  | 'manage_companies'
  | 'manage_staff';

// Matriz 2 (aprobada). Criterio: staff opera el día a día (filas marcadas);
// super_admin toca todo lo que afecta dinero, precios o comportamiento del producto.
const STAFF_MATRIX: Record<StaffCapability, StaffTier[]> = {
  view_companies: ['staff', 'super_admin'],
  review_flagged_rows: ['staff', 'super_admin'],
  view_job_status: ['staff', 'super_admin'],
  view_ai_usage_cost: ['staff', 'super_admin'],
  topup_credits: ['super_admin'],
  edit_action_to_credits_ratio: ['super_admin'],
  edit_credits_to_tokens_param: ['super_admin'],
  manage_plans_and_templates: ['super_admin'],
  manage_companies: ['super_admin'],
  manage_staff: ['super_admin'],
};

export function staffCan(tier: StaffTier, capability: StaffCapability): boolean {
  return STAFF_MATRIX[capability].includes(tier);
}

// Invariantes de negocio sobre company_users (Matriz 1, notas de Jose). No hay
// endpoint de gestión de miembros todavía (depende de esta ticket); se documentan
// aquí para que la implementación futura de invite/remove/change-role no las pierda:
// - Toda empresa tiene exactamente un owner.
// - Transferir la propiedad es una acción explícita, nunca una edición de rol.
// - El owner no puede autodegradarse ni eliminarse si es el único de la empresa.
