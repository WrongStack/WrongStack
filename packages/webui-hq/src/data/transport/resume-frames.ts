/**
 * Resume framing — turns the browser's per-publisher cursor map into the
 * `client.resume` frames sent immediately after a socket opens.
 *
 * Pure and side-effect free so the framing rules (normalisation, ordering,
 * the frame cap, the peer-cursor reservation) are testable without a socket.
 */
import type { HqClientResumeMessage } from '@wrongstack/core/hq';
import { HQ_BROWSER_PEER_RESUME_CLIENT_ID } from '@wrongstack/core/hq/protocol';

export type HqResumeCursor = ReadonlyMap<string, number> | Readonly<Record<string, number>>;

/**
 * Cap on `client.resume` frames per reconnect. A long-lived dashboard
 * accumulates a cursor entry per publisher it has ever seen; without a cap a
 * stale map would blow the 1 MB WS frame budget on every reconnect.
 */
export const MAX_RESUME_FRAMES = 32;

/** Coerce an untrusted seq into a safe, non-negative integer. */
export function normalizeResumeSeq(seq: number): number {
  if (!Number.isFinite(seq)) return 0;
  const normalized = Math.max(0, Math.trunc(seq));
  return Number.isSafeInteger(normalized) ? normalized : 0;
}

function cursorEntries(cursor: HqResumeCursor): Iterable<[string, number]> {
  return typeof (cursor as { entries?: unknown }).entries === 'function'
    ? (cursor as { entries: () => IterableIterator<[string, number]> }).entries()
    : Object.entries(cursor);
}

/**
 * Build the resume frames for one reconnect.
 *
 * Ordering: highest `lastSeqSeen` first (most recently active publishers are
 * the ones worth gap-filling), ties broken by clientId so the frame sequence
 * is deterministic. The synthetic peer cursor (`__hq_peer__`) is always kept
 * and always sent first — it tracks server-minted peer-lifecycle envelopes,
 * whose seq numbers are small and would otherwise be trimmed away.
 */
export function buildResumeFrames(cursor: HqResumeCursor): HqClientResumeMessage[] {
  try {
    const parsed: { clientId: string; lastSeqSeen: number }[] = [];
    for (const [clientId, seq] of cursorEntries(cursor)) {
      if (typeof clientId !== 'string' || clientId.length === 0) continue;
      parsed.push({ clientId, lastSeqSeen: normalizeResumeSeq(seq) });
    }

    parsed.sort((a, b) =>
      b.lastSeqSeen !== a.lastSeqSeen
        ? b.lastSeqSeen - a.lastSeqSeen
        : a.clientId.localeCompare(b.clientId),
    );

    const peerCursor = parsed.find(({ clientId }) => clientId === HQ_BROWSER_PEER_RESUME_CLIENT_ID);
    const nonPeerLimit = peerCursor === undefined ? MAX_RESUME_FRAMES : MAX_RESUME_FRAMES - 1;
    const trimmed = parsed
      .filter(({ clientId }) => clientId !== HQ_BROWSER_PEER_RESUME_CLIENT_ID)
      .slice(0, nonPeerLimit);
    if (peerCursor !== undefined) trimmed.unshift(peerCursor);

    return trimmed.map(({ clientId, lastSeqSeen }) => ({
      type: 'client.resume',
      clientId,
      lastSeqSeen,
    }));
  } catch {
    // A hostile or exotic cursor object must never stop the socket from
    // opening; resume is best-effort and the server falls back to a snapshot.
    return [];
  }
}
