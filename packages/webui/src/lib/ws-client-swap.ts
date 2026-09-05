import { hasLane } from '../stores/chat-lanes';
import type { WSClientMessage, WSUserMessageImage } from '../types';

/**
 * Stand-in target for a `session.new`: the client asked the server to create a
 * session and cannot name it until the answer arrives. Never a real id — the
 * server issues opaque ids, and the leading `#` is not in that alphabet.
 */
export const NEW_SESSION_SWAP_TARGET = '#pending-new-session';

/** Bound on `seenSessionIds`; four tabs plus a long tail of retired ones. */
export const MAX_SEEN_SESSION_IDS = 64;

/** Minimum spacing between automatic `session_not_ready` retries for ONE session. */
export const NOT_READY_RETRY_COOLDOWN_MS = 15_000;

/** Upper bound on parked retries, so tab churn cannot grow the map forever. */
export const MAX_ARMED_RESENDS = 8;

/**
 * The session a swap request is asking to land on, or `null` when the message
 * is not a swap request at all. `session.resume` names its target in
 * `payload.id`; `session.new` has none yet.
 */
export function resolveSwapTarget(message: WSClientMessage): string | null {
  if (message.type === 'session.new') return NEW_SESSION_SWAP_TARGET;
  if (message.type !== 'session.resume') return null;
  const id = (message as { payload?: { id?: unknown } }).payload?.id;
  return typeof id === 'string' && id.length > 0 ? id : NEW_SESSION_SWAP_TARGET;
}

/**
 * Is this `session.start` the answer to the swap this client is waiting on?
 *
 * A resume names its target, so it matches by id. A `session.new` cannot —
 * the server invents the id — so its answer is recognised as the first RESET
 * announcement naming a session this client has never seen. Requiring
 * `reset` keeps an unrelated first-sight announcement (a background tab the
 * server announces on its own) from consuming the grant.
 */
export function matchesPendingSwap(
  pendingSwapTarget: string | null,
  seenSessionIds: Set<string>,
  payload: { sessionId: string; reset?: boolean },
): boolean {
  if (!pendingSwapTarget || !payload.sessionId) return false;
  if (pendingSwapTarget !== NEW_SESSION_SWAP_TARGET) return pendingSwapTarget === payload.sessionId;
  return payload.reset === true && !seenSessionIds.has(payload.sessionId);
}

export function rememberSeenSession(seenSessionIds: Set<string>, sessionId: string): void {
  if (!sessionId) return;
  if (seenSessionIds.size >= MAX_SEEN_SESSION_IDS) {
    // Insertion-ordered: drop the oldest rather than the whole set, so the
    // four live tabs are never forgotten in one step.
    const oldest = seenSessionIds.values().next();
    if (!oldest.done) seenSessionIds.delete(oldest.value);
  }
  seenSessionIds.add(sessionId);
}

export function armNotReadyResendHelper(
  armedResends: Map<
    string,
    {
      content: string;
      freshContext?: boolean | undefined;
      images?: WSUserMessageImage[] | undefined;
      armedAt: number;
    }
  >,
  sessionId: string,
  message: {
    content: string;
    freshContext?: boolean | undefined;
    images?: WSUserMessageImage[] | undefined;
  },
): boolean {
  if (!sessionId) return false;
  const now = Date.now();
  const held = armedResends.get(sessionId);
  if (held && now - held.armedAt < NOT_READY_RETRY_COOLDOWN_MS) {
    return false;
  }
  if (armedResends.size >= MAX_ARMED_RESENDS) {
    const oldest = armedResends.keys().next();
    if (!oldest.done) armedResends.delete(oldest.value);
  }
  armedResends.set(sessionId, { ...message, armedAt: now });
  return true;
}

export function consumeArmedResendHelper(
  armedResends: Map<
    string,
    {
      content: string;
      freshContext?: boolean | undefined;
      images?: WSUserMessageImage[] | undefined;
      armedAt: number;
    }
  >,
  sessionId: string,
  onResend: (
    content: string,
    images?: WSUserMessageImage[],
    freshContext?: boolean,
    sessionId?: string,
  ) => void,
): void {
  const held = armedResends.get(sessionId);
  if (!held) return;
  armedResends.delete(sessionId);
  if (!hasLane(sessionId)) return;
  onResend(held.content, held.images, held.freshContext === true, sessionId);
}

export function sweepExpiredPendingConfirmsHelper(
  pendingConfirms: Map<string, { expiresAtMs: number }>,
  now: number,
): void {
  for (const [id, entry] of pendingConfirms) {
    if (entry.expiresAtMs <= now) pendingConfirms.delete(id);
  }
}
