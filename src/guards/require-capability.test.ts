import { describe, expect, test } from 'bun:test';
import { Elysia } from 'elysia';
import { assertClientCapability, assertStaffCapability } from './require-capability';
import type { ClientRole, StaffTier } from '@/lib/permissions';

function appAsRole(role: ClientRole) {
  return new Elysia()
    .derive(() => ({ role }))
    .get('/billing', ({ role, set }) => {
      assertClientCapability(role, 'billing', set);
      return 'ok';
    });
}

function appAsTier(tier: StaffTier) {
  return new Elysia()
    .derive(() => ({ tier }))
    .get('/staff', ({ tier, set }) => {
      assertStaffCapability(tier, 'manage_staff', set);
      return 'ok';
    });
}

describe('assertClientCapability (smoke)', () => {
  test('blocks a client role missing the capability', async () => {
    const res = await appAsRole('member').handle(new Request('http://localhost/billing'));
    expect(res.status).toBe(403);
  });

  test('allows a client role with the capability', async () => {
    const res = await appAsRole('owner').handle(new Request('http://localhost/billing'));
    expect(res.status).toBe(200);
  });
});

describe('assertStaffCapability (smoke)', () => {
  test('blocks a staff tier missing the capability', async () => {
    const res = await appAsTier('staff').handle(new Request('http://localhost/staff'));
    expect(res.status).toBe(403);
  });

  test('allows a staff tier with the capability', async () => {
    const res = await appAsTier('super_admin').handle(new Request('http://localhost/staff'));
    expect(res.status).toBe(200);
  });
});
