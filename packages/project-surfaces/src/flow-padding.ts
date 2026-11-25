/**
 * Fit-view padding for React Flow 13.
 *
 * React Flow 12 read a bare number as a fraction of the fitted bounds: with
 * padding `p` the content filled `1 / (1 + p)` of the viewport. React Flow 13
 * reads a bare number as pixels, so the same `0.15` frames the graph edge to
 * edge. This keeps the framing every surface was tuned with by converting the
 * fraction to the per-side viewport percentage React Flow 13 accepts.
 */
export function fitPadding(fraction: number): `${number}%` {
  if (!Number.isFinite(fraction) || fraction <= 0) return '0%';
  const perSide = (100 * fraction) / (2 * (1 + fraction));
  return `${Math.round(perSide * 10) / 10}%`;
}
