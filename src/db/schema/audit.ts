import { pgTable, uuid, text, jsonb, timestamp, index } from 'drizzle-orm/pg-core';
import { staff } from './identity';

// 4.27 admin_audit_log (APPEND-ONLY) — every admin mutation (US-16/20/21).
export const adminAuditLog = pgTable(
  'admin_audit_log',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    actorStaffId: uuid('actor_staff_id')
      .notNull()
      .references(() => staff.id),
    companyId: uuid('company_id'),
    action: text('action').notNull(), // e.g. company.suspend, credit.topup, alert_rule.update
    targetTable: text('target_table'),
    /*
     * TEXTO y no `uuid` (migración 0037, bug del 2026-08-27). Esta tabla es un registro
     * genérico: `target_table` es texto libre, así que la clave de la fila apuntada no tiene
     * por qué ser un uuid. `plans.code` y `platform_settings.key` son texto, y con la columna
     * en `uuid` **auditarlas lanzaba** `invalid input syntax for type uuid` — dentro de la
     * misma transacción que la escritura de negocio, así que además la deshacía. Medido: cero
     * planes editados y cero parámetros guardados en producción desde que existen.
     */
    targetId: text('target_id'),
    metadata: jsonb('metadata').$type<Record<string, unknown>>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    companyIdx: index('admin_audit_log_company_created_idx').on(t.companyId, t.createdAt),
    actorIdx: index('admin_audit_log_actor_created_idx').on(t.actorStaffId, t.createdAt),
    actionIdx: index('admin_audit_log_action_idx').on(t.action),
  }),
);
