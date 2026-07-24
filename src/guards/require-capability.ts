import type { Context } from 'elysia';
import {
  clientCan,
  staffCan,
  type ClientCapability,
  type ClientRole,
  type StaffCapability,
  type StaffTier,
} from '@/lib/permissions';

// Called from inside a route handler chained after tenantDerive (which resolves
// `role` from company_users): assertClientCapability(role, 'billing', set).
// Elysia's .guard()/.macro() generics don't reliably thread a plugin's `derive`
// singleton into a standalone beforeHandle value in this Elysia version — calling
// this inline, where `role`/`set` are already concretely typed by the route itself,
// sidesteps that instead of fighting the generics.
export function assertClientCapability(
  role: ClientRole,
  capability: ClientCapability,
  set: Context['set'],
): void {
  if (!clientCan(role, capability)) {
    set.status = 403;
    throw new Error(`Role '${role}' lacks capability '${capability}'`);
  }
}

// Same pattern for /admin/* routes chained after adminGuard (which resolves `tier`
// from the staff table — real identity resolution lands in CU-868kfvaex).
export function assertStaffCapability(
  tier: StaffTier,
  capability: StaffCapability,
  set: Context['set'],
): void {
  if (!staffCan(tier, capability)) {
    set.status = 403;
    throw new Error(`Staff tier '${tier}' lacks capability '${capability}'`);
  }
}
