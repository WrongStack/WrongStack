/** Number and time formatting shared by every HQ view. */

/** 1_234_567 -> "1.2M". Compact counts for badges and metric rows. */
export function formatCount(value: number): string {
  if (!Number.isFinite(value)) return '0';
  if (Math.abs(value) >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (Math.abs(value) >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
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

/** "820ms" / "4.2s" / "3m 05s". */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '';
  if (ms < 1_000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1_000);
  return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
}

/** Shorten an opaque id for display while keeping both ends recognisable. */
export function shortenId(id: string, head = 8, tail = 4): string {
  return id.length > head + tail + 1 ? `${id.slice(0, head)}…${id.slice(-tail)}` : id;
}
