import { MAX_ACTION_DEPTH } from './limits.js';

/**
 * Normalize an action type string before allow-list comparison:
 * - Trim whitespace
 * - Reject empty/null/undefined
 */
export function normalizeActionType(type: string): string | null {
  const trimmed = String(type ?? '').trim();
  if (trimmed.length === 0) return null;
  return trimmed;
}

/**
 * Measure the maximum nesting depth of a value.
 * Used to prevent prototype-pollution / deep-object DoS.
 */
export function measureDepth(value: unknown, depth: number): number {
  if (depth > MAX_ACTION_DEPTH) return depth;
  if (value === null || typeof value !== 'object') return depth;
  if (Array.isArray(value)) {
    let max = depth;
    for (const item of value.slice(0, 10)) {
      // Only sample first 10 to avoid perf DoS
      const d = measureDepth(item, depth + 1);
      if (d > max) max = d;
      if (max > MAX_ACTION_DEPTH) return max;
    }
    return max;
  }
  let max = depth;
  for (const v of Object.values(value as Record<string, unknown>).slice(0, 10)) {
    const d = measureDepth(v, depth + 1);
    if (d > max) max = d;
    if (max > MAX_ACTION_DEPTH) return max;
  }
  return max;
}
