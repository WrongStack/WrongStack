/**
 * Side-effect audit records read back from a session journal.
 *
 * `side_effects.list` serves the live runtime window (at most 500 records, emptied by a host
 * restart). Every record is also appended to the session JSONL as a `side_effect` event, so this
 * reads that durable copy with the same paging shape: `before` is an exclusive index into the
 * journal's records in write order and `limit` is 1–200 (default 100).
 */

import type { SessionEvent } from '@wrongstack/contracts/types';

type SideEffectEvent = Extract<SessionEvent, { type: 'side_effect' }>;

export function readJournalSideEffects(
  sessionId: string,
  events: readonly SessionEvent[],
  raw: unknown,
) {
  const paging = (raw && typeof raw === 'object' ? raw : {}) as {
    before?: unknown;
    limit?: unknown;
  };
  const all = events.filter((event): event is SideEffectEvent => event.type === 'side_effect');
  const limit =
    Number.isSafeInteger(paging.limit) && (paging.limit as number) >= 1
      ? Math.min(paging.limit as number, 200)
      : 100;
  const end =
    Number.isSafeInteger(paging.before) && (paging.before as number) >= 0
      ? Math.min(paging.before as number, all.length)
      : all.length;
  const start = Math.max(0, end - limit);
  return {
    sessionId,
    total: all.length,
    truncated: start > 0,
    start,
    sideEffects: all.slice(start, end).map((effect) => ({
      toolUseId: effect.toolUseId,
      toolName: effect.toolName,
      ts: effect.ts,
      input: effect.input,
      ...(effect.outcome !== undefined ? { outcome: effect.outcome } : {}),
      risk: effect.risk,
    })),
  };
}
