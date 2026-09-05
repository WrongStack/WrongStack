import { safeId } from '@/lib/utils';
import type { WSClientMessage, WSServerMessage } from '../types';

export const CHAT_ECHO_RESPONSE_BY_REQUEST: Partial<
  Record<WSClientMessage['type'], WSServerMessage['type']>
> = {
  'context.debug': 'context.debug',
  'diag.get': 'diag.get',
  'memory.list': 'memory.list',
  'memory.sage.get': 'memory.sage.get',
  'memory.sage.graph': 'memory.sage.graph',
  'memory.sage.list': 'memory.sage.list',
  'memory.sage.listCandidates': 'memory.sage.listCandidates',
  'memory.sage.listPage': 'memory.sage.listPage',
  'memory.sage.remember': 'memory.sage.remember',
  'memory.sage.update': 'memory.sage.update',
  'skills.list': 'skills.list',
  'stats.get': 'stats.get',
  'tools.list': 'tools.list',
};

export const CHAT_ECHO_SUPPRESSION_TTL_MS = 30_000;

/**
 * Cadence of the lazy echo-suppression sweep (see ensureEchoSweep). Chosen
 * at 2x the TTL granularity: stale timestamps are released within one
 * sweep interval of expiry without a per-push clock read.
 */
export const CHAT_ECHO_SUPPRESSION_SWEEP_MS = 15_000;

export class WsClientEchoSuppression {
  suppressedChatEchoes = new Map<string, number>();
  echoSweepTimer: ReturnType<typeof setInterval> | null = null;

  registerSuppression(
    message: WSClientMessage,
    options: { echoToChat?: boolean; requestId?: string },
  ): void {
    if (options.echoToChat !== false) return;
    const responseType = CHAT_ECHO_RESPONSE_BY_REQUEST[message.type];
    if (!responseType) return;

    // Mint a correlation id (or use the one the caller supplied) and
    // register it for the response. B-04: with the previous FIFO-by-type
    // queue, tab A's suppression could swallow tab B's `/tools` reply
    // if the two responses interleaved across tabs. Keying the
    // suppression by requestId makes the drop exactly one-to-one: the
    // server echoes the requestId, and only the matching response
    // consumes its slot. Unstamped responses are left alone, so a
    // chat-issued command that produces a response of the same type
    // is never silently lost.
    const requestId = options.requestId ?? `suppress_${Date.now()}_${safeId().slice(0, 8)}`;
    this.suppressedChatEchoes.set(requestId, Date.now() + CHAT_ECHO_SUPPRESSION_TTL_MS);
    this.ensureEchoSweep();

    // The mint must reach the server for the response to be
    // correlatable; piggy-back on the existing payload.
    const targetPayload = ((message as { payload?: Record<string, unknown> }).payload ??
      {}) as Record<string, unknown>;
    targetPayload.requestId = requestId;
    (message as { payload?: Record<string, unknown> }).payload = targetPayload;
  }

  /**
   * Consume one UI-originated response that must not be mirrored into chat.
   *
   * B-04: the suppression map is keyed by requestId. The caller passes the
   * full message so we can read the `requestId` echoed by the server; only
   * the matching request consumes a slot. A response with no (or
   * unrecognised) requestId is left alone — that is exactly the case the
   * previous FIFO queue got wrong: tab A's suppression swallowed tab B's
   * chat-issued `/tools` reply when B's response happened to arrive first.
   *
   * Pass `msg` whenever the caller has it (the central WS_HANDLERS path
   * does). When `msg` is missing, no suppression is possible — that
   * matches the audit's instruction that suppression must be correlated
   * end-to-end, never type-keyed.
   */
  consumeSuppressedChatEcho(responseType: string, msg?: WSServerMessage): boolean {
    if (!msg) return false;
    const requestId = (msg.payload as { requestId?: unknown } | undefined)?.requestId;
    if (typeof requestId !== 'string' || requestId.length === 0) return false;
    const expiry = this.suppressedChatEchoes.get(requestId);
    if (expiry === undefined) return false;
    this.suppressedChatEchoes.delete(requestId);
    // An expired requestId MUST NOT consume — a late response from a
    // request whose chat-echo window has elapsed would otherwise be
    // dropped silently. The sweep keeps the map tidy, but on the consume
    // path we still let the response through so the user sees the late
    // reply in their chat.
    return expiry > Date.now();
  }

  /**
   * Lazy periodic sweep for `suppressedChatEchoes`. TTL trimming otherwise
   * runs only on consume — a requestId that was minted but never consumed
   * (chat view unmounted, user on another screen) would otherwise retain
   * its timestamp indefinitely. The sweep bounds retention to TTL + one
   * sweep interval and self-stops when the map empties, so no timer runs
   * for clients that never suppress. RAM-leak audit 2026-08-11 Finding 4
   * / fix 2026-08-16.
   */
  private ensureEchoSweep(): void {
    if (this.echoSweepTimer) return;
    this.echoSweepTimer = setInterval(() => {
      this.sweepSuppressedChatEchoes(Date.now());
    }, CHAT_ECHO_SUPPRESSION_SWEEP_MS);
  }

  private sweepSuppressedChatEchoes(now: number): void {
    for (const [requestId, expiry] of this.suppressedChatEchoes) {
      if (expiry <= now) this.suppressedChatEchoes.delete(requestId);
    }
    if (this.suppressedChatEchoes.size === 0 && this.echoSweepTimer) {
      clearInterval(this.echoSweepTimer);
      this.echoSweepTimer = null;
    }
  }

  clear(): void {
    if (this.echoSweepTimer) {
      clearInterval(this.echoSweepTimer);
      this.echoSweepTimer = null;
    }
    this.suppressedChatEchoes.clear();
  }
}
