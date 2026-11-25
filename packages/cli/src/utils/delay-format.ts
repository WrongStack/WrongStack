/**
 * Format a millisecond delay as a human-readable string (e.g. "30s", "2m", "disabled").
 */
export function formatDelay(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return 'disabled';
  if (ms >= 60_000) return `${Math.round(ms / 60_000)}m`;
  // 59.7s rounds to 60: show it as the minute it is.
  const s = Math.round(ms / 1000);
  return s >= 60 ? '1m' : `${s}s`;
}
