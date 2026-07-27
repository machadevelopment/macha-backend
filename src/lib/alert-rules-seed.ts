import type { DB } from '@/db/client';
import { alertRules } from '@/db/schema';
import { alertCatalog } from '@/config/alert-catalog';

/**
 * Seeds the default alert_rules for a newly-provisioned company (CU-868kfvad3
 * catalog, real thresholds approved by Jose). Extracted from scripts/seed.ts (which
 * only seeded the demo company) so real company provisioning — self-serve (M8) and
 * admin manual creation (F7) — gets the same defaults, not just the seed script.
 */
export async function seedDefaultAlertRules(db: DB, companyId: string): Promise<void> {
  await db.insert(alertRules).values(
    alertCatalog.map((entry) => ({
      companyId,
      ruleKey: entry.ruleKey,
      threshold: String(entry.defaultThreshold),
      notifyImmediately: entry.notifyImmediately,
    })),
  );
}
