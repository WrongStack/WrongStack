/**
 * Anthropic accepts at most 4 `cache_control` breakpoints per request, counted
 * globally across `tools` + `system` + message content. A rich system prompt
 * (skills + mode + mode-skill hint + plan + autonomy contributors + the two
 * per-turn volatile blocks) can carry 5–7 ephemeral markers, which the API
 * rejects with `400 invalid_request`. This is the single chokepoint that caps
 * the count, keeping the markers that protect the most cache and dropping the
 * redundant middle ones.
 *
 * Dropping a middle breakpoint never worsens caching: Anthropic matches the
 * longest cached prefix, and a dropped shorter prefix is fully contained in the
 * next kept (longer) prefix — it was only a redundant fallback. The function
 * never *adds* a marker, so it can only ever preserve or improve validity.
 */

export const ANTHROPIC_MAX_BREAKPOINTS = 4;

interface WireBody {
  tools?: unknown;
  system?: unknown;
  messages?: unknown;
}

interface Marker {
  /** The wire object bearing `cache_control` (mutated in place when dropped). */
  block: Record<string, unknown>;
  /** Cumulative wire size up to and including this block — the prefix length. */
  prefix: number;
  /** True for the caller's ttl-forced breakpoint (identified by `cache_control.ttl`). */
  pinned: boolean;
  /** True when the marker sits in `messages` rather than `tools`/`system`. */
  inMessages: boolean;
}

/** Approximate wire weight of a block, used only to rank prefix gaps. */
function weigh(x: unknown): number {
  if (x && typeof x === 'object') {
    const o = x as Record<string, unknown>;
    if (typeof o['text'] === 'string') return (o['text'] as string).length;
    if (typeof o['content'] === 'string') return (o['content'] as string).length;
  }
  if (typeof x === 'string') return x.length;
  try {
    return JSON.stringify(x).length;
  } catch {
    return 0;
  }
}

function hasCacheControl(o: Record<string, unknown>): boolean {
  const cc = o['cache_control'];
  return !!cc && typeof cc === 'object';
}

function isPinned(o: Record<string, unknown>): boolean {
  const cc = o['cache_control'];
  return !!cc && typeof cc === 'object' && (cc as Record<string, unknown>)['ttl'] != null;
}

/**
 * Collect every cache_control-bearing block in wire order (tools → system →
 * messages), tagging each with its cumulative prefix length and pinned state.
 */
function collectMarkers(body: WireBody): Marker[] {
  const markers: Marker[] = [];
  let prefix = 0;
  let inMessages = false;

  const visit = (block: unknown): void => {
    prefix += weigh(block);
    if (!block || typeof block !== 'object') return;
    const o = block as Record<string, unknown>;
    if (hasCacheControl(o)) markers.push({ block: o, prefix, pinned: isPinned(o), inMessages });
  };

  if (Array.isArray(body.tools)) for (const t of body.tools) visit(t);
  if (Array.isArray(body.system)) for (const b of body.system) visit(b);
  if (Array.isArray(body.messages)) {
    inMessages = true;
    for (const m of body.messages) {
      const content = (m as Record<string, unknown> | null)?.['content'];
      if (typeof content === 'string') {
        prefix += content.length;
        continue;
      }
      if (Array.isArray(content)) for (const b of content) visit(b);
    }
  }
  return markers;
}

/**
 * Ensure at most `limit` cache_control breakpoints reach the wire. When over
 * budget, keep: the first marker (anchors the fully-static tools+identity
 * prefix), the last marker (largest incremental prefix — the conversation
 * cache-hit each turn), every pinned/ttl marker (honors caller intent), the
 * second-newest marker inside `messages`, then fill remaining slots by the
 * largest prefix-token gap so the surviving breakpoints partition the request
 * as evenly as possible. `cache_control` is deleted from every dropped block in
 * place — so the wire objects must be fresh clones, never shared with
 * `ctx.systemPrompt`.
 *
 * The two newest message markers are kept together on purpose: they are this
 * request's prefix and the entry the PREVIOUS request wrote. Keeping only the
 * deepest one leaves the hit to Anthropic's bounded automatic look-back, which
 * a turn with many parallel tool calls can overrun. Gap-fill would rank the
 * pair poorly — they sit close together at the very end — so it is selected
 * before the generic fill.
 */
export function capAnthropicCacheBreakpoints(
  body: WireBody,
  limit: number = ANTHROPIC_MAX_BREAKPOINTS,
): void {
  const markers = collectMarkers(body);
  if (markers.length <= limit) return;

  const pinned = markers.reduce<number[]>((indices, marker, index) => {
    if (marker.pinned) indices.push(index);
    return indices;
  }, []);
  const keep = new Set(pinned.length > limit ? pinned.slice(-limit) : pinned);

  if (keep.size < limit) keep.add(0);
  if (keep.size < limit) keep.add(markers.length - 1);

  const messageMarkers = markers.reduce<number[]>((acc, marker, i) => {
    if (marker.inMessages) acc.push(i);
    return acc;
  }, []);
  const secondNewestMessage = messageMarkers[messageMarkers.length - 2];
  if (secondNewestMessage !== undefined && keep.size < limit) keep.add(secondNewestMessage);

  // Fill remaining slots: repeatedly take the not-yet-kept marker that is
  // farthest (in prefix tokens) from its nearest already-kept neighbor.
  while (keep.size < limit) {
    let bestIdx = -1;
    let bestDist = -1;
    for (let i = 0; i < markers.length; i++) {
      if (keep.has(i)) continue;
      const mi = markers[i];
      if (!mi) continue;
      let nearest = Number.POSITIVE_INFINITY;
      for (const k of keep) {
        const mk = markers[k];
        if (!mk) continue;
        const d = Math.abs(mi.prefix - mk.prefix);
        if (d < nearest) nearest = d;
      }
      // Deterministic tie-break: strictly-greater keeps the earliest index.
      if (nearest > bestDist) {
        bestDist = nearest;
        bestIdx = i;
      }
    }
    if (bestIdx === -1) break;
    keep.add(bestIdx);
  }

  for (let i = 0; i < markers.length; i++) {
    if (!keep.has(i)) delete markers[i]?.block['cache_control'];
  }
}
