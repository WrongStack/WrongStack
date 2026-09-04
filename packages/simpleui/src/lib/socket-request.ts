import type { SimpleSocket } from './ws.js';

/**
 * Correlated request/response over the shared WebSocket.
 *
 * SimpleUI panels previously hand-rolled the same dance five times:
 * subscribe → send → match reply type → 3-8s timeout → settle. Replies were
 * matched only by frame type (plus an ad-hoc field check), so two concurrent
 * `files.read` requests for the same file could cross-talk. This helper
 * centralizes the pattern:
 *
 *  - resolves with the payload of the first frame matching `expectType`
 *    (and the optional `accept` predicate, e.g. matching a returned path);
 *  - resolves with `null` on timeout or cancellation — never rejects, so
 *    callers only need the happy path plus a null check;
 *  - `cancel()` unsubscribes and resolves with null (call it when a newer
 *    request supersedes this one, or on unmount).
 *
 * The wire protocol has no request ids; correlation is therefore frame-type +
 * predicate based, but the single-flight discipline (cancel before re-send)
 * that this helper enforces removes the cross-talk window in practice.
 */

export interface ServerFrame {
  type: string;
  payload?: unknown;
}

export interface SocketRequestConfig {
  socket: SimpleSocket;
  sendType: string;
  payload: Record<string, unknown>;
  expectType: string;
  /** Extra acceptance test over the reply frame (e.g. returned path match). */
  accept?: (frame: ServerFrame) => boolean;
  /** Default 8000ms, matching the previous hand-rolled timeouts. */
  timeoutMs?: number;
}

export interface SocketRequestHandle {
  /** First accepted reply payload, or null when cancelled / timed out. */
  promise: Promise<Record<string, unknown> | null>;
  /** Stop listening; the promise resolves with null. Idempotent. */
  cancel: () => void;
}

export function socketRequest(config: SocketRequestConfig): SocketRequestHandle {
  const { socket, sendType, payload, expectType, accept, timeoutMs = 8000 } = config;

  let settled = false;
  let resolvePromise: ((value: Record<string, unknown> | null) => void) | null = null;
  let unsub: (() => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const finish = (): void => {
    if (settled) return;
    settled = true;
    if (timer) clearTimeout(timer);
    unsub?.();
  };

  const promise = new Promise<Record<string, unknown> | null>((resolve) => {
    resolvePromise = resolve;

    const handler = (frame: ServerFrame): void => {
      if (settled) return;
      if (frame.type !== expectType) return;
      if (accept && !accept(frame)) return;
      finish();
      const replyPayload = frame.payload;
      resolve(
        replyPayload && typeof replyPayload === 'object'
          ? (replyPayload as Record<string, unknown>)
          : {},
      );
    };

    unsub = socket.onMessage(handler as never);
    try {
      socket.send(sendType, payload);
    } catch {
      // The never-reject contract: a send failure settles the request with
      // null exactly like a timeout, and tears down the subscription so the
      // reply handler cannot leak.
      finish();
      resolvePromise(null);
      return;
    }
    timer = setTimeout(() => {
      finish();
      resolve(null);
    }, timeoutMs);
  });

  return {
    promise,
    cancel: () => {
      finish();
      resolvePromise?.(null);
    },
  };
}
