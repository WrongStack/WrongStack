import type { TextBlock } from '@wrongstack/contracts/types/blocks';
import type { RequestLayoutTailEntry } from '../utils/request-layout.js';

/**
 * Blocks that belong to the next provider request only — raw mailbox mail is
 * the case that matters. They ride the live-context tail (after the deepest
 * cache boundary) instead of the durable conversation.
 *
 * They used to be folded into the last user message and removed again after
 * the response. That message is exactly where the previous request closed its
 * cached prefix, so the removal rewrote the cache boundary on every mailbox
 * turn: the next request missed the entry and re-wrote that turn's history.
 * Kept out of history, the conversation stays append-only and nothing has to
 * be cleaned up but this per-context list.
 */
const scoped = new WeakMap<object, RequestLayoutTailEntry[]>();

export function addRequestScopedBlock(ctx: object, block: TextBlock, source = 'mailbox'): void {
  const entries = scoped.get(ctx);
  if (entries) entries.push({ source, block });
  else scoped.set(ctx, [{ source, block }]);
}

/** Blocks for the request being built; empty when there are none. */
export function requestScopedEntries(ctx: object): readonly RequestLayoutTailEntry[] {
  return scoped.get(ctx) ?? [];
}

/** Drop the blocks once a response evaluated them (or the run ends). */
export function clearRequestScopedBlocks(ctx: object): void {
  scoped.delete(ctx);
}
