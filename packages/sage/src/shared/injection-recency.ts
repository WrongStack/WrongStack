import type { Sage } from '../types.js';

/**
 * Kinds that stay true until the code changes: rules, prohibitions, user
 * preferences and root causes. Anchor verification, not age, retires them.
 */
const EVERGREEN_KINDS: ReadonlySet<Sage['kind']> = new Set([
  'convention',
  'anti_pattern',
  'preference',
  'security_signal',
  'bug_root_cause',
  'role_operational',
  'fleet_convention',
]);

/** Tag every consolidation lesson carries (see consolidation/distill.ts). */
export const CONSOLIDATED_TAG = 'consolidated';

/** Written and last referenced longer ago than this: no longer auto-injected. */
export const INJECTION_AGE_OUT_MS = 45 * 86_400_000;
const PINNED_IMPORTANCE = 0.9;

/**
 * Use-or-expire for automatic injection (GitHub Copilot memory expires unused
 * entries after 28 days for the same reason). Judged on replayed sessions,
 * facts, decisions, workflows and notes written over 45 days ago and not
 * referenced since were almost all stale measurements, inventories and
 * superseded plans: dropping them raised judged precision from 60% to 69%
 * without losing one actionable injection. The memory stays searchable.
 *
 * Age counts from `createdAt` and `lastUsedAt` only: `updatedAt` was re-dated
 * by every hygiene pass before the verification-stamp fix, so it cannot say
 * when the content was last confirmed useful.
 */
export function isAgedOutForInjection(
  memory: Pick<Sage, 'kind' | 'persistence' | 'importance' | 'createdAt' | 'lastUsedAt'> & {
    tags?: readonly string[] | undefined;
  },
  nowMs: number,
): boolean {
  if (memory.persistence === 'permanent' || memory.importance >= PINNED_IMPORTANCE) return false;
  // A model-distilled lesson has to earn its keep whatever kind it claims: one
  // nobody references ages out like any other note instead of riding the
  // evergreen exemption (consolidation reads untrusted memory text).
  if (EVERGREEN_KINDS.has(memory.kind) && !memory.tags?.includes(CONSOLIDATED_TAG)) return false;
  const created = Date.parse(memory.createdAt);
  const used = Date.parse(memory.lastUsedAt ?? '');
  const lastTouch =
    Number.isFinite(used) && Number.isFinite(created)
      ? Math.max(used, created)
      : Number.isFinite(used)
        ? used
        : created;
  return (
    Number.isFinite(nowMs) &&
    Number.isFinite(lastTouch) &&
    nowMs - lastTouch >= INJECTION_AGE_OUT_MS
  );
}
