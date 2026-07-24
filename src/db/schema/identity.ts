import { pgTable, uuid, text, boolean, timestamp, uniqueIndex, index } from 'drizzle-orm/pg-core';
import { companies } from './companies';

// 4.2 users — minimal mirror of WorkOS user. NEVER stores credentials. Not tenant-scoped.
export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  workosUserId: text('workos_user_id').notNull(),
  email: text('email').notNull(),
  name: text('name'),
  locale: text('locale').$type<'es' | 'en'>().notNull().default('es'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  workosUserUq: uniqueIndex('users_workos_user_uq').on(t.workosUserId),
  // UNIQUE(lower(email)) is applied as raw SQL (expression index) in migration.
}));

// 4.3 company_users — user<->company membership with business role. Core of authz.
export const companyUsers = pgTable('company_users', {
  id: uuid('id').primaryKey().defaultRandom(),
  companyId: uuid('company_id').notNull().references(() => companies.id),
  userId: uuid('user_id').notNull().references(() => users.id),
  role: text('role').$type<'owner' | 'admin' | 'member'>().notNull().default('member'),
  receivesReports: boolean('receives_reports').notNull().default(true),
  invitedBy: uuid('invited_by'),
  status: text('status').$type<'active' | 'invited' | 'revoked'>().notNull().default('active'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  companyUserUq: uniqueIndex('company_users_company_user_uq').on(t.companyId, t.userId),
  companyRoleIdx: index('company_users_company_role_idx').on(t.companyId, t.role),
  userIdx: index('company_users_user_idx').on(t.userId), // org-switcher
}));

// 4.4 staff — internal Macha personnel. Gates /admin/*, separate from tenant chain.
export const staff = pgTable('staff', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id),
  tier: text('tier').$type<'staff' | 'super_admin'>().notNull().default('staff'),
  status: text('status').$type<'active' | 'disabled'>().notNull().default('active'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  userUq: uniqueIndex('staff_user_uq').on(t.userId),
  tierIdx: index('staff_tier_idx').on(t.tier),
}));
