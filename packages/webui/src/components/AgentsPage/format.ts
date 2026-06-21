/**
 * Pure presentation helpers for AgentsPage — extracted so the giant page
 * component stays focused on rendering/state. AgentsPage.tsx re-exports these
 * for backward compatibility (existing imports from '../AgentsPage' keep
 * working). No React, no stores — trivially unit-testable.
 */

/** AgentsPage-local compact cost formatter. '$0' for non-positive, otherwise
 *  3-decimal precision (or 5 decimals for sub-cent values). Differs from the
 *  shared dashboard-primitives fmtCost which always pads to 4 decimals. */
export function fmtCost(n?: number): string {
  if (n == null || !Number.isFinite(n) || n <= 0) return '$0';
  if (n < 0.01) return `$${n.toFixed(5)}`;
  return `$${n.toFixed(3)}`;
}

/** AgentsPage-local duration formatter. Returns "Xs" for sub-minute, "Xm Ys"
 *  for ≥1min. Always shows the seconds component when minutes are present. */
export function fmtDuration(ms?: number): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return '—';
  const totalSec = Math.floor(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return s === 0 ? `${m}m 0s` : `${m}m ${s}s`;
}

/** AgentsPage-local elapsed formatter. "MM:SS" (zero-padded) for sub-hour,
 *  "H:MM:SS" otherwise. Differs from dashboard-primitives' "Xs/Xm/Xh" form. */
export function fmtElapsed(ms?: number): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return '—';
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

const SPARK_CHARS = ' ▁▂▃▄▅▆▇█';

/** AgentsPage-local sparkline. Uses ceil(v/max * 8) clamped to [1, 8] so that
 *  0 → ▁ (not blank) and max → █. Differs from dashboard-primitives which uses
 *  round(v/max * 4) over a 5-char palette. */
export function sparkline(values: number[], width = 40): string {
  if (values.length === 0) return '';
  const max = Math.max(1, ...values);
  const step = Math.max(1, Math.floor(values.length / width));
  const sampled: number[] = [];
  for (let i = 0; i < values.length; i += step) {
    sampled.push(values[i]!);
  }
  return sampled
    .map((v) => {
      const h = Math.min(8, 1 + Math.ceil((v / max) * 7));
      return SPARK_CHARS[h] ?? '·';
    })
    .join('');
}

/** Bucket recent tool timestamps into N bins of binMs each. */
export function bucketActivity(
  timestamps: number[],
  now: number,
  bins = 12,
  binMs = 2000,
): number[] {
  const out = new Array<number>(bins).fill(0);
  const windowStart = now - bins * binMs;
  for (const at of timestamps) {
    if (at < windowStart || at > now) continue;
    let idx = Math.floor((at - windowStart) / binMs);
    if (idx < 0) idx = 0;
    if (idx >= bins) idx = bins - 1;
    out[idx] = (out[idx] ?? 0) + 1;
  }
  return out;
}
