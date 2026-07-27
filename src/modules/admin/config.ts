import { Elysia, t } from 'elysia';
import { adminGuard } from '@/guards/admin.guard';
import { assertStaffCapability } from '@/guards/require-capability';
import { db } from '@/db/client';
import { getAllPlatformSettings, setPlatformSetting, SETTINGS_KEYS } from '@/lib/settings';
import { logAdminAction } from '@/lib/admin-audit';

const VALID_KEYS = new Set(Object.values(SETTINGS_KEYS));

/** CU-868kfvafy criterio 1 (no negociable): créditos↔tokens + catálogo de insight, configurables desde el panel. */
export const adminConfig = new Elysia({ prefix: '/admin/config' })
  .use(adminGuard)
  .get('/', async ({ tier, set }) => {
    assertStaffCapability(tier, 'edit_credits_to_tokens_param', set);
    return getAllPlatformSettings(db);
  })
  .patch(
    '/:key',
    async ({ staffId, tier, params, body, set }) => {
      if (!VALID_KEYS.has(params.key as (typeof SETTINGS_KEYS)[keyof typeof SETTINGS_KEYS])) {
        set.status = 400;
        return { error: `Unknown setting key: ${params.key}` };
      }
      assertStaffCapability(tier, 'edit_credits_to_tokens_param', set);
      await setPlatformSetting(db, params.key, body.value, staffId);
      await logAdminAction({
        actorStaffId: staffId,
        action: 'platform_setting.update',
        targetTable: 'platform_settings',
        targetId: params.key,
        metadata: { value: body.value },
      });
      return { key: params.key, value: body.value };
    },
    { body: t.Object({ value: t.Unknown() }) },
  );
