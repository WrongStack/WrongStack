const MAX_TIMEOUT_MS = 2_147_483_647;

/** Resolve a promise after `ms` milliseconds. Prefer this over raw
 *  `setTimeout` wrappers so all delay sites use a single implementation
 *  and an abortable variant can be introduced without a codebase-wide hunt. */
export function sleep(ms: number): Promise<void> {
  const safeMs =
    typeof ms === 'number' && !Number.isNaN(ms) ? Math.min(MAX_TIMEOUT_MS, Math.max(0, ms)) : 0;
  return new Promise((resolve) => setTimeout(resolve, safeMs));
}
