import type { ACPClientTransport } from '../agent/stdio-transport.js';
import type { ACPMessage } from '../types/acp-messages.js';
import type { SessionId } from '../types/acp-v1.js';

/** Bound for the best-effort late-session release. `session/cancel` is a
 * notification — the server sends no response — so this only bounds a hung
 * transport, not a protocol wait. `session/close` is a request, but nothing
 * waits for its answer either, so both sends share the same bound. */
const LATE_CANCEL_SEND_TIMEOUT_MS = 10_000;

/**
 * Release a session the agent confirmed AFTER its waiter had given up (the
 * abort-during-creation race). The id was never adopted, so this is the last
 * chance to free it.
 *
 * `session/cancel` only cancels a turn — it releases nothing — so an agent
 * that advertises `sessionCapabilities.close` gets a real `session/close`
 * instead. `closeRequestId` supplies that request's id from the session's own
 * counter, so the answer cannot be mistaken for a pending call. Without the
 * capability the cancel stays the best available lever.
 *
 * Fire-and-forget: a failure or timeout is surfaced on the warn channel rather
 * than thrown, because the caller has already returned to its own caller.
 */
export function cancelLateAcpSession(
  transport: ACPClientTransport,
  createPromise: Promise<SessionId>,
  closeRequestId?: (() => number) | undefined,
): void {
  const label = closeRequestId ? 'late session/close' : 'late session/cancel';
  const buildMessage = (lateId: SessionId): ACPMessage =>
    closeRequestId
      ? ({
          jsonrpc: '2.0',
          id: closeRequestId(),
          method: 'session/close',
          params: { sessionId: lateId },
        } as never as ACPMessage)
      : ({
          jsonrpc: '2.0',
          method: 'session/cancel',
          params: { sessionId: lateId },
        } as never as ACPMessage);

  createPromise
    .then(async (lateId) => {
      try {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => {
            // Plain Error, not kind:'aborted' — the wire hung, nobody aborted.
            reject(new Error(`${label} send timed out`));
          }, LATE_CANCEL_SEND_TIMEOUT_MS);
          Promise.resolve()
            .then(() => transport.send(buildMessage(lateId)))
            .then(
              () => {
                clearTimeout(timer);
                resolve();
              },
              (sendErr: unknown) => {
                clearTimeout(timer);
                reject(sendErr instanceof Error ? sendErr : new Error(String(sendErr)));
              },
            );
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // eslint-disable-next-line no-console
        console.warn(
          JSON.stringify({
            level: 'warn',
            event: 'acp_session.late_cancel_failed',
            sessionId: lateId,
            message,
          }),
        );
      }
    })
    .catch((reason: unknown) => {
      // The abandoned creation itself failed after we stopped waiting
      // (e.g. the server refused the late session/new): nothing is left
      // to cancel, but the refusal is observable, not swallowed.
      const message = reason instanceof Error ? reason.message : String(reason);
      // eslint-disable-next-line no-console
      console.warn(
        JSON.stringify({
          level: 'warn',
          event: 'acp_session.late_cancel_failed',
          reason: message,
        }),
      );
    });
}
