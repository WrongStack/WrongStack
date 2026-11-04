// Copies of the WebUI agent-status formatters (that module also carries fleet view types).

/**
 * Format token count for display: "1.2K" / "3.4M" / raw number.
 * Handles Infinity, NaN, and negative values by returning "0".
 */
export function fmtTok(n: number | undefined | null): string {
  if (n == null || !Number.isFinite(n) || n < 0) return '0';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(Math.round(n));
}

/**
 * Format USD cost for display.
 *
 * - <=0 or non-finite -> "$0"
 * - <$0.01 -> 5 decimal places (sub-cent precision); values below 5e-6
 *   round to 5 zeroes at 5 decimals and render as "$0"
 * - >=$0.01 -> 3 decimal places
 */
export function fmtCost(n: number | undefined | null): string {
  if (n == null || !Number.isFinite(n) || n <= 0) return '$0';
  if (n < 0.01) {
    const s = n.toFixed(5);
    // All zeros at 5 decimals — value is effectively $0
    if (s === '0.00000') return '$0';
    return '$' + s.replace(/(\d)0+$/, '$1').replace(/\.$/, '');
  }
  return '$' + n.toFixed(3);
}
