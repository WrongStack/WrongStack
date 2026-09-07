/** Number and time formatting shared by every HQ view. */

/** 1_234_567 -> "1.2M". Compact counts for badges and metric rows. */
export function formatCount(value: number): string {
  if (!Number.isFinite(value)) return '0';
  const magnitude = Math.abs(value);
  if (magnitude >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (magnitude >= 1_000) {
    // The unit must be chosen from the ROUNDED mantissa, not the raw value.
    // `.toFixed(1)` rounds up, so a count below the M threshold can still
    // print 1000.0 — and "1000.0k" is one full step past its own unit, which
    // also made the badges non-monotonic (999_999 -> "1000.0k" while
    // 1_000_000 -> "1.0M"). Carry into the next unit instead.
    const thousands = Number((value / 1_000).toFixed(1));
    if (Math.abs(thousands) >= 1_000) return `${(value / 1_000_000).toFixed(1)}M`;
    return `${thousands.toFixed(1)}k`;
  }
  return String(Math.trunc(value));
}

/**
 * Fleet spend. Four decimals below a dollar because a single agent turn often
 * costs fractions of a cent, and rounding those to `$0.00` hides the signal.
 */
export function formatUsd(value: number): string {
  if (!Number.isFinite(value)) return '$0.0000';
  return value >= 1 ? `$${value.toFixed(2)}` : `$${value.toFixed(4)}`;
}

export function formatPercent(fraction: number, digits = 0): string {
  if (!Number.isFinite(fraction)) return '0%';
  return `${(fraction * 100).toFixed(digits)}%`;
}

/** Wall-clock, no date — transcripts and audit rows are about today. */
export function formatClock(timestamp: string | number | Date): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

// Durations are formatted by the canonical `formatDuration` in
// src/domain/transcript-format.ts. A duplicate lived here, drifted out of
// sync (rendered "1m 60s" in the last 500 ms of each minute), and was
// removed in proof-driven bug-hunter round 20260907-r1 — do not reintroduce it.

/** Shorten an opaque id for display while keeping both ends recognisable. */
export function shortenId(id: string, head = 8, tail = 4): string {
  return id.length > head + tail + 1 ? `${id.slice(0, head)}…${id.slice(-tail)}` : id;
}
