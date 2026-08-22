import { toErrorMessage } from '@wrongstack/core/utils';
import type { WebSocket } from 'ws';
import type { WSServerMessage } from '../types.js';
import type { CollabContext } from './collab-context.js';

/** How many historical events to replay to a late-joining observer. */
export const REPLAY_LIMIT = 50;

/**
 * Replay the last `REPLAY_LIMIT` events from the on-disk session log
 * to a single observer (the late joiner). Each event is forwarded as
 * a `collab.event` with `replay: true` so the client can distinguish
 * history from the live stream.
 *
 * The session log stores typed `SessionEvent`s (`user_input`,
 * `llm_response`, `tool_result`, etc.) — different from the kernel's
 * bus events. We translate the most useful subset (`tool.*` and
 * `iteration.*`-shaped ones) into the same `kind` namespace the live
 * mirror uses, so the client can render a single activity strip.
 *
 * Moved verbatim from CollaborationWebSocketHandler (6A-2).
 */
export async function replayHistory(
  ctx: CollabContext,
  ws: WebSocket,
  sessionId: string,
): Promise<void> {
  if (!ctx.reader) return;
  // Keep only the trailing REPLAY_LIMIT events in a ring instead of
  // materializing the whole session log. `reader.replay` is already an async
  // iterator; buffering all of it just to `slice(-50)` meant a late joiner
  // pulled an entire (unbounded) session history into memory first.
  const ring: unknown[] = new Array(REPLAY_LIMIT);
  let seen = 0;
  try {
    for await (const ev of ctx.reader.replay(sessionId)) {
      ring[seen % REPLAY_LIMIT] = ev;
      seen++;
    }
  } catch (err) {
    ctx.logger.debug?.(`collab: session reader rejected ${sessionId}: ${toErrorMessage(err)}`);
    return;
  }
  const tail =
    seen <= REPLAY_LIMIT
      ? ring.slice(0, seen)
      : // Unwrap the ring back into chronological order.
        [...ring.slice(seen % REPLAY_LIMIT), ...ring.slice(0, seen % REPLAY_LIMIT)];
  if (tail.length === 0) return; // nothing to replay
  for (const raw of tail) {
    const ev = raw as {
      type?: string | undefined;
      ts?: string | undefined;
      [k: string]: unknown;
    };
    const kind = historyEventToKind(ev);
    if (!kind) continue; // skip events we don't know how to mirror
    const msg: WSServerMessage = {
      type: 'collab.event',
      payload: {
        kind,
        payload: ev,
        at: ev.ts ?? new Date().toISOString(),
        replay: true,
      },
    };
    ctx.send(ws, msg);
  }
}

/**
 * Map a stored `SessionEvent` to a `collab.event.kind` so the live
 * strip and the history strip can share a single rendering path.
 * Returns null for events that don't have a meaningful live analog
 * (e.g. `session_start`, file-snapshot bookkeeping, rewind markers).
 */
function historyEventToKind(ev: { type?: string | undefined }): string | null {
  switch (ev.type) {
    case 'user_input':
      return 'user_input';
    case 'llm_response':
      return 'llm_response';
    case 'tool_result':
      return 'tool.executed';
    case 'compaction':
      return 'compaction';
    case 'error':
      return 'error';
    default:
      return null;
  }
}
