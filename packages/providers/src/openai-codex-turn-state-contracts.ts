import type { Request } from '@wrongstack/contracts/types';

/** Sticky-routing token the ChatGPT backend hands back on every response. */
export const CODEX_TURN_STATE_HEADER = 'x-codex-turn-state';

/** Bound on remembered turn-state entries so a long-lived process cannot grow. */
export const CODEX_TURN_STATE_MAX_SESSIONS = 64;

/**
 * Is this request a continuation of the turn already in flight, rather than a
 * new user turn?
 *
 * `x-codex-turn-state` is scoped to ONE turn: the official client keeps it in a
 * turn-scoped `OnceLock` and replays it on the requests that finish that turn
 * (the tool-call round-trips), never on the next user turn. In the canonical
 * message shape a tool-call round-trip is a user message carrying tool results,
 * so that is the boundary this reproduces.
 */
export function isTurnContinuation(req: Request): boolean {
  const last = req.messages[req.messages.length - 1];
  if (last?.role !== 'user' || !Array.isArray(last.content)) return false;
  return last.content.some((block) => block.type === 'tool_result');
}
