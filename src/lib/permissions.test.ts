import { describe, expect, test } from 'bun:test';
import {
  clientCan,
  staffCan,
  type ClientCapability,
  type ClientRole,
  type StaffCapability,
  type StaffTier,
} from './permissions';

// Matriz 1 aprobada por Jose en CU-868kfv96c — un caso por capacidad, roles exactos permitidos.
const CLIENT_CASES: [ClientCapability, ClientRole[]][] = [
  ['view_dashboard_reports', ['owner', 'admin', 'member']],
  ['chat', ['owner', 'admin', 'member']],
  ['upload_excel', ['owner', 'admin', 'member']],
  ['revert_upload', ['owner', 'admin']],
  ['edit_send_reports', ['owner', 'admin']],
  ['configure_alerts', ['owner', 'admin']],
  ['manage_members', ['owner']],
  ['change_roles', ['owner']],
  ['billing', ['owner']],
];

const ALL_CLIENT_ROLES: ClientRole[] = ['owner', 'admin', 'member'];

describe('clientCan (Matriz 1 — aprobada CU-868kfv96c)', () => {
  for (const [capability, allowedRoles] of CLIENT_CASES) {
    for (const role of ALL_CLIENT_ROLES) {
      const expected = allowedRoles.includes(role);
      test(`${role} ${expected ? 'puede' : 'no puede'} ${capability}`, () => {
        expect(clientCan(role, capability)).toBe(expected);
      });
    }
  }
});

// Matriz 2 aprobada por Jose en CU-868kfv96c.
const STAFF_CASES: [StaffCapability, StaffTier[]][] = [
  ['view_companies', ['staff', 'super_admin']],
  ['review_flagged_rows', ['staff', 'super_admin']],
  ['view_job_status', ['staff', 'super_admin']],
  ['view_ai_usage_cost', ['staff', 'super_admin']],
  ['topup_credits', ['super_admin']],
  ['edit_action_to_credits_ratio', ['super_admin']],
  ['edit_credits_to_tokens_param', ['super_admin']],
  ['manage_plans_and_templates', ['super_admin']],
  ['manage_companies', ['super_admin']],
  ['manage_staff', ['super_admin']],
];

const ALL_STAFF_TIERS: StaffTier[] = ['staff', 'super_admin'];

describe('staffCan (Matriz 2 — aprobada CU-868kfv96c)', () => {
  for (const [capability, allowedTiers] of STAFF_CASES) {
    for (const tier of ALL_STAFF_TIERS) {
      const expected = allowedTiers.includes(tier);
      test(`${tier} ${expected ? 'puede' : 'no puede'} ${capability}`, () => {
        expect(staffCan(tier, capability)).toBe(expected);
      });
    }
  }
});
