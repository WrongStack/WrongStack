import type { MemoryAnchor } from './types.js';

/**
 * Fast structural comparison of two anchor arrays — avoids the expense of
 * `syncAnchorEdges` (DELETE + RETURNING + re-INSERT) when anchors haven't
 * meaningfully changed. Common case: text-only merges and tag-only updates.
 *
 * Order-independent: sorts the canonical JSON of each anchor before comparing
 * so the result doesn't depend on insertion order from `dedupeAnchors` or
 * the merge path — eliminating the implicit dependency on normalization
 * preserving a stable prefix.
 */
export function anchorsChanged(a: MemoryAnchor[], b: MemoryAnchor[]): boolean {
  if (a.length !== b.length) return true;
  // Sort by canonical JSON so position doesn't matter. O(n log n) on
  // small arrays (<128 items), negligible compared to the edge-sync cost.
  const aSorted = a.map((anchor) => JSON.stringify(anchor, Object.keys(anchor).sort())).sort();
  const bSorted = b.map((anchor) => JSON.stringify(anchor, Object.keys(anchor).sort())).sort();
  for (let i = 0; i < aSorted.length; i++) {
    if (aSorted[i] !== bSorted[i]) return true;
  }
  return false;
}
