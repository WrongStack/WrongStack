/**
 * Shared TTL (time-to-live) duration parser.
 *
 * Accepts:
 *   "1h"       → 1 hour
 *   "7d"       → 7 days
 *   "30m"      → 30 minutes
 *   "3600s"    → 1 hour
 *   "86400000" → 1 day (bare milliseconds)
 *
 * Compound durations ("1h30m") are intentionally NOT supported — a single
 * unit is always sufficient for a rotation cadence.
 *
 * @module cli/utils/hq-ttl
 */

const TTL_UNIT_MS: Record<string, number> = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
};

interface ParsedTtl {
  value?: number | undefined;
  error?: string | undefined;
}

const MAX_DATE_MS = 8_640_000_000_000_000; // ±100,000,000 days, max ECMAScript Date range
// The TTL is stamped as `now + ttl` (later than this parse; a day of slack), so
// the room left is the range minus now.
const maxSafeTtlMs = (): number => MAX_DATE_MS - Date.now() - 86_400_000;

export function parseTokenTtlValue(raw: string): ParsedTtl {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { error: 'TTL value is empty' };
  }
  // Bare integer → milliseconds.
  if (/^\d+$/.test(trimmed)) {
    const ms = Number.parseInt(trimmed, 10);
    if (!Number.isFinite(ms) || ms <= 0) {
      return { error: `TTL value must be positive (got ${raw})` };
    }
    if (!Number.isSafeInteger(ms) || ms > maxSafeTtlMs()) {
      return { error: `TTL value exceeds maximum safe duration (got ${raw})` };
    }
    return { value: ms };
  }
  // <number><unit> — capture the trailing unit suffix.
  const match = /^(?<value>\d+)(?<unit>ms|s|m|h|d|w)$/i.exec(trimmed);
  if (match?.groups) {
    const value = Number.parseInt(match.groups.value!, 10);
    const unit = match.groups.unit!.toLowerCase();
    const multiplier = TTL_UNIT_MS[unit];
    if (!Number.isFinite(value) || value <= 0 || multiplier === undefined) {
      return { error: `TTL value must be positive with a valid unit (got ${raw})` };
    }
    const totalMs = value * multiplier;
    if (
      !Number.isSafeInteger(value) ||
      !Number.isSafeInteger(totalMs) ||
      totalMs > maxSafeTtlMs()
    ) {
      return { error: `TTL value exceeds maximum safe duration (got ${raw})` };
    }
    return { value: totalMs };
  }
  return {
    error:
      `TTL must be a positive integer (milliseconds) or <number><unit> ` +
      `where unit is one of ms, s, m, h, d, w (got ${raw})`,
  };
}
