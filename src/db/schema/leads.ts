import { pgTable, uuid, text, timestamp, index } from 'drizzle-orm/pg-core';

/**
 * Solicitudes de demo desde la landing pública (Jose, 2026-08-21). Migración `0036`.
 *
 * Append-only y sin `company_id` ni RLS: quien llena el formulario todavía no es cliente de
 * ninguna empresa, así que no hay a qué scopear la fila. Lo que la protege es el guard —el POST es
 * público y solo escribe; leerla exige `/admin/*`—. El "por qué" completo, incluido por qué NO hay
 * estado "contactado", está en la migración.
 *
 * De la IP se guarda un HASH con sal, nunca la IP: para lo único que se necesita es contar cuántas
 * vinieron del mismo origen, y un hash responde eso igual sin dejar un dato personal en una tabla
 * que lee todo el staff.
 */
export const demoRequests = pgTable(
  'demo_requests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    companyName: text('company_name').notNull(),
    email: text('email').notNull(),
    phone: text('phone'),
    message: text('message'),
    /** Idioma en que se llenó, para responder en el correcto. Se pierde si no se guarda. */
    locale: text('locale').notNull().default('es'),
    /** Hoy siempre `landing`. Existe para no migrar cuando haya un segundo formulario. */
    source: text('source').notNull().default('landing'),
    /** sha256(ip + sal del servidor). Ver la nota de arriba. */
    ipHash: text('ip_hash').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    /** La consulta del límite por origen, que corre en cada envío. */
    origenIdx: index('demo_requests_origen_idx').on(t.ipHash, t.createdAt),
    recientesIdx: index('demo_requests_recientes_idx').on(t.createdAt),
  }),
);
