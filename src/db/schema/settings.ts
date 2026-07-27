import { pgTable, text, jsonb, uuid, timestamp } from 'drizzle-orm/pg-core';

// platform_settings — CU-868kfvafy criterio 1 (no negociable): parámetros de negocio
// (acción↔créditos vive en credit_rules, ya existente; créditos↔tokens y el catálogo
// de prompts de insight NO tenían tabla propia — vivían en config/credits.ts y un
// hardcode en lib/anthropic.ts respectivamente). Key-value simple en vez de una
// columna por parámetro: evita otra migración cada vez que se agregue un ajuste más.
export const platformSettings = pgTable('platform_settings', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
  updatedBy: uuid('updated_by'), // staff.id
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
