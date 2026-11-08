export type PayloadValidationResult<T> = { ok: true; value: T } | { ok: false; message: string };

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * S10: clamp a model-controlled `limit`/`maxNodes`/etc. to a known-safe
 * range. Every unclamped limit the audit found has a clamped sibling
 * three lines away (chronicle.query limit=10000, the HTTP
 * vector-memory route Math.min(50, …), hops Math.min(hops, 10)) — the
 * gaps were parity drift, not design. The single helper is the
 * symmetry-enforcement point: a future route that forgets the clamp
 * fails the architecture test instead of degrading silently.
 */
export function clampLimit(value: unknown, def: number, max: number): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : def;
  if (n < 1) return 1;
  return Math.min(n, max);
}
