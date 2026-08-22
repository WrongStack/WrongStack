import type { Logger } from '@wrongstack/core/types';
import type { TelegramApiCallbackQuery, TelegramApiClient } from './api-client.js';

export interface TelegramApprovalResult {
  approved: boolean;
  fromUser: string;
  fromUserId?: number | undefined;
}

export interface TelegramApprovalRequestInput {
  requestId: string;
  sessionId: string;
  expectedChatId: string | number;
  expectedUserIds: readonly (string | number)[];
  /** Group/supergroup callbacks are rejected unless this was explicitly enabled. */
  allowGroup: boolean;
  expiresAt: number;
  /** Cancels the request when its owning tool execution is aborted. */
  signal?: AbortSignal | undefined;
}

type TelegramApprovalRequestState = 'pending' | 'resolved' | 'expired' | 'cancelled';

interface TelegramApprovalRequest {
  requestId: string;
  sessionId: string;
  expectedChatId: string;
  expectedUserIds: ReadonlySet<string>;
  allowGroup: boolean;
  promptMessageId?: number | undefined;
  pendingCallbacks: TelegramApiCallbackQuery[];
  expiresAt: number;
  state: TelegramApprovalRequestState;
  resolve: (value: TelegramApprovalResult) => void;
  timer: ReturnType<typeof setTimeout>;
  signal?: AbortSignal | undefined;
  abortHandler?: (() => void) | undefined;
}

export interface ApprovalFlowDeps {
  log: Logger;
  /**
   * Live accessor for the bot's API client rather than a captured reference.
   * Tests swap `bot.api` via Object.assign after construction; reading the
   * client through the owner at call time preserves that seam exactly as the
   * pre-extraction methods did (they lived on the bot and read `this.api`).
   */
  api: () => TelegramApiClient;
  /**
   * Shared inbound identity policy (chat checked before user; empty set =
   * unrestricted on that dimension; missing identity fails closed). Owned by
   * the bot because ordinary messages apply the same gate.
   */
  inboundDenialReason(
    userId: string | undefined,
    chatId: string | undefined,
  ): 'user' | 'chat' | undefined;
}

/**
 * Telegram human-approval state machine (card 7A-2).
 *
 * Owns the pending-request registry and its exactly-once settle semantics.
 * Every request binds both yes/no actions to its originating session, target
 * chat, intended users, prompt message, and expiry. Callbacks arriving before
 * the prompt's message_id is known are queued on the request and replayed by
 * `bindApprovalPrompt` — no second waiter, no second timer.
 *
 * Moved verbatim from bot.ts; the bot keeps thin delegating methods so the
 * public surface (awaitApproval / bindApprovalPrompt / cancelApproval) is
 * unchanged for tool callers.
 */
export class ApprovalFlow {
  // Pending approval requests keyed by request identity, not raw callback
  // data. Each request binds both yes/no actions to its originating session,
  // target chat, intended users, prompt message, and expiry.
  readonly callbackWaiters = new Map<string, TelegramApprovalRequest>();

  private readonly log: Logger;
  private readonly api: ApprovalFlowDeps['api'];
  private readonly inboundDenialReason: ApprovalFlowDeps['inboundDenialReason'];

  constructor(deps: ApprovalFlowDeps) {
    this.log = deps.log;
    this.api = deps.api;
    this.inboundDenialReason = deps.inboundDenialReason;
  }

  /**
   * Resolve a pending approval request exactly once and record its terminal
   * state before removing it from the live registry.
   */
  settleApproval(
    requestId: string,
    state: Exclude<TelegramApprovalRequestState, 'pending'>,
    result: TelegramApprovalResult,
  ): boolean {
    const request = this.callbackWaiters.get(requestId);
    if (request?.state !== 'pending') return false;
    request.state = state;
    clearTimeout(request.timer);
    if (request.signal && request.abortHandler) {
      request.signal.removeEventListener('abort', request.abortHandler);
    }
    const leftoverCallbacks = request.pendingCallbacks.splice(0);
    for (const cq of leftoverCallbacks) {
      const notice =
        state === 'expired'
          ? 'Approval request expired'
          : state === 'cancelled'
            ? 'Approval request cancelled'
            : 'Approval request settled';
      void this.answerCallback(cq.id, notice, true);
    }
    this.callbackWaiters.delete(requestId);
    request.resolve(result);
    return true;
  }

  async dispatchCallback(cq: TelegramApiCallbackQuery): Promise<void> {
    const key = cq.data ?? '';
    const action = /^approve:([^:]+):(yes|no)$/.exec(key);
    const requestId = action?.[1];
    const request = requestId ? this.callbackWaiters.get(requestId) : undefined;

    // Use the same coarse inbound policy as messages before applying the
    // request-specific identity binding below. Unauthorized callbacks are
    // acknowledged but never consume the valid user's pending request.
    const userId = cq.from?.id !== undefined ? String(cq.from.id) : undefined;
    const chatId = cq.message?.chat.id !== undefined ? String(cq.message.chat.id) : undefined;
    const denialReason = this.inboundDenialReason(userId, chatId);
    if (denialReason) {
      const identity = denialReason === 'user' ? (userId ?? 'unknown') : (chatId ?? 'unknown');
      this.log.warn(
        `Ignoring callback_query from non-allowlisted ${denialReason} ${identity} (data="${key}") — possible hijack attempt.`,
      );
      await this.answerCallback(cq.id, '⛔ Not authorized', true);
      return;
    }

    if (!request || !requestId || !action) {
      await this.answerCallback(cq.id, 'Approval request unavailable', true);
      this.log.debug(`Unmatched callback_query data="${key}" (no pending approval request)`);
      return;
    }

    if (Date.now() >= request.expiresAt) {
      await this.answerCallback(cq.id, 'Approval request expired', true);
      this.settleApproval(requestId, 'expired', { approved: false, fromUser: 'timeout' });
      return;
    }

    // The request is registered before sendMessage so a callback can arrive
    // before the Bot API response supplies message_id. Keep exactly that
    // callback queued until bindApprovalPrompt attaches the sent prompt.
    if (request.promptMessageId === undefined) {
      request.pendingCallbacks.push(cq);
      return;
    }

    const messageId = cq.message?.message_id;
    const chatType = cq.message?.chat.type;
    const wrongIdentity =
      userId === undefined ||
      chatId !== request.expectedChatId ||
      !request.expectedUserIds.has(userId) ||
      messageId !== request.promptMessageId ||
      (chatType !== 'private' && !request.allowGroup);
    if (wrongIdentity) {
      this.log.warn(
        `Ignoring callback_query that does not match approval request ${request.requestId} in session ${request.sessionId}.`,
      );
      await this.answerCallback(cq.id, '⛔ Not authorized for this approval', true);
      return;
    }

    const approved = action[2] === 'yes';
    const fromUser = cq.from?.username ?? cq.from?.first_name ?? `user:${userId}`;
    const resolved = this.settleApproval(requestId, 'resolved', {
      approved,
      fromUser,
      fromUserId: cq.from?.id,
    });
    await this.answerCallback(
      cq.id,
      resolved ? (approved ? 'Approved ✓' : 'Denied ✗') : 'Approval request unavailable',
      !resolved,
    );
  }

  /**
   * POST /answerCallbackQuery for a callback. Best-effort: failures are
   * logged at debug and swallowed — the caller's resolve() must not depend
   * on the ack reaching Telegram (the user may get a "loading" spinner if
   * it fails, but the agent's approval flow continues normally).
   */
  private async answerCallback(
    callbackQueryId: string,
    text: string,
    showAlert: boolean,
  ): Promise<void> {
    try {
      await this.api().answerCallbackQuery(callbackQueryId, text, showAlert, {
        signal: AbortSignal.timeout(5_000),
      });
    } catch (err) {
      this.log.debug(`answerCallbackQuery failed: ${(err as Error).message}`);
    }
  }

  /**
   * Register one approval request before its prompt is sent. The returned
   * promise owns the request's only timer and resolves on one terminal event.
   */
  awaitApproval(input: TelegramApprovalRequestInput): Promise<TelegramApprovalResult> {
    if (input.expectedUserIds.length === 0) {
      throw new Error('Telegram approval requires at least one expected user ID.');
    }
    if (this.callbackWaiters.has(input.requestId)) {
      throw new Error(`Telegram approval request ${input.requestId} is already pending.`);
    }

    return new Promise((resolve) => {
      const delayMs = Math.max(0, input.expiresAt - Date.now());
      const timer = setTimeout(() => {
        this.settleApproval(input.requestId, 'expired', {
          approved: false,
          fromUser: 'timeout',
        });
      }, delayMs);
      const request: TelegramApprovalRequest = {
        requestId: input.requestId,
        sessionId: input.sessionId,
        expectedChatId: String(input.expectedChatId),
        expectedUserIds: new Set(input.expectedUserIds.map(String)),
        allowGroup: input.allowGroup,
        pendingCallbacks: [],
        expiresAt: input.expiresAt,
        state: 'pending',
        resolve,
        timer,
        signal: input.signal,
      };
      if (input.signal) {
        request.abortHandler = () => {
          this.settleApproval(input.requestId, 'cancelled', {
            approved: false,
            fromUser: 'aborted',
          });
        };
      }
      this.callbackWaiters.set(input.requestId, request);
      if (input.signal?.aborted) {
        request.abortHandler?.();
      } else if (input.signal && request.abortHandler) {
        input.signal.addEventListener('abort', request.abortHandler, { once: true });
      }
    });
  }

  /**
   * Attach the Bot API response's prompt message ID to an existing request.
   * Any callback that arrived during the send is replayed against the fully
   * bound identity without allocating a second waiter or timer.
   */
  bindApprovalPrompt(requestId: string, promptMessageId: number): boolean {
    const request = this.callbackWaiters.get(requestId);
    if (request?.state !== 'pending' || request.promptMessageId !== undefined) return false;
    request.promptMessageId = promptMessageId;
    const pending = request.pendingCallbacks.splice(0);
    for (const callback of pending) {
      void this.dispatchCallback(callback).catch((err) =>
        this.log.debug(
          `Callback dispatch failed: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
    }
    return true;
  }

  /** Cancel a request that cannot reach a valid terminal callback. */
  cancelApproval(requestId: string, fromUser = 'cancelled'): boolean {
    return this.settleApproval(requestId, 'cancelled', { approved: false, fromUser });
  }

  /** Reject every pending request (shutdown path) so no host call hangs. */
  cancelAll(fromUser: string): void {
    for (const requestId of Array.from(this.callbackWaiters.keys())) {
      this.settleApproval(requestId, 'cancelled', {
        approved: false,
        fromUser,
      });
    }
  }
}
