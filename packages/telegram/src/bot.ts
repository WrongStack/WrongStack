import type { Logger } from '@wrongstack/core/types';
import {
  abortableSleep,
  classifyRetry,
  TelegramApiClient,
  type TelegramApiMessage,
  TelegramBotApiError,
  TelegramNetworkError,
} from './api-client.js';
import {
  ApprovalFlow,
  type TelegramApprovalRequestInput,
  type TelegramApprovalResult,
} from './approval-flow.js';
import type { OffsetStore } from './offset-store.js';
import type { PollLock } from './poll-lock.js';
import { Poller } from './poller.js';

export interface TelegramBotResponse<T> {
  ok: true;
  result: T;
}

// ---------------------------------------------------------------------------
// Incoming message shape emitted as a custom event
// ---------------------------------------------------------------------------

export interface TelegramIncomingMessage {
  messageId: number;
  chatId: number;
  chatType: string;
  userId?: number | undefined;
  userName?: string | undefined;
  text: string;
  timestamp: number;
}

export type { TelegramApprovalRequestInput, TelegramApprovalResult } from './approval-flow.js';

// ---------------------------------------------------------------------------
// Bot options
// ---------------------------------------------------------------------------

export interface TelegramBotOptions {
  token: string;
  pollIntervalSec: number;
  allowedUsers: Set<string>;
  allowedChats: Set<string>;
  /** Max messages to buffer for the agent to read. Default: 50. */
  bufferSize: number;
  log: Logger;
  /**
   * Resolved on every outbound send so live `parseMode` config changes
   * (via `api.onConfigChange`) take effect without restarting the plugin.
   * Empty string or `undefined` → plain text. See `TelegramPluginConfig.parseMode`.
   */
  getParseMode?: () => '' | 'HTML' | 'MarkdownV2' | undefined;
  /** Called for each incoming message that passes allowlist checks. */
  onMessage(msg: TelegramIncomingMessage): void;
  /**
   * Optional typed offset store. When provided, the polling offset is persisted
   * atomically on every successful poll and restored on startup, preventing
   * message replay after crashes or restarts.
   */
  offsetStore?: OffsetStore | undefined;
  /**
   * Optional cross-process single-poller lock. Telegram allows one
   * `getUpdates` consumer per token; when another wstack instance holds the
   * lock, this bot stands by (no polling) and takes over once the holder
   * stops or its heartbeat goes stale.
   */
  lock?: PollLock | undefined;
  /** How often a standby instance retries acquiring the lock. Default: 15s. */
  standbyRetryMs?: number | undefined;
}

// ---------------------------------------------------------------------------
// Bot
// ---------------------------------------------------------------------------

export class TelegramBot {
  private readonly api: TelegramApiClient;
  private readonly allowedUsers: Set<string>;
  private readonly allowedChats: Set<string>;
  private readonly log: Logger;
  private readonly onMessage: (msg: TelegramIncomingMessage) => void;
  /** Single-poller election across wstack instances sharing this token. */
  private readonly lock?: PollLock | undefined;
  private readonly getParseMode?: (() => '' | 'HTML' | 'MarkdownV2' | undefined) | undefined;

  // Circular buffer for incoming messages
  private readonly bufferMax: number;
  private readonly buffer: TelegramIncomingMessage[] = [];

  /**
   * Approval state machine (card 7A-2); the bot keeps thin delegates only.
   * Public readonly so the white-box regression suite can pin the real
   * owner (tests/unit/bot-callback.test.ts) without type-asserting past
   * `private`.
   */
  readonly approvals: ApprovalFlow;

  /**
   * Polling loop owner (card 7A-3): standby/lock retry, 409 conflict
   * backoff, and the P1.6 offset cursor. Public readonly so the white-box
   * suites (bot-coverage-completion, p3-fault-injection) pin the real
   * owner via `bot.poller` instead of type-asserting past `private`.
   */
  readonly poller: Poller;

  constructor(opts: TelegramBotOptions) {
    this.api = new TelegramApiClient({ token: opts.token });
    this.allowedUsers = opts.allowedUsers;
    this.allowedChats = opts.allowedChats;
    this.bufferMax = opts.bufferSize;
    this.log = opts.log;
    this.onMessage = opts.onMessage;
    this.lock = opts.lock;
    this.getParseMode = opts.getParseMode;
    this.approvals = new ApprovalFlow({
      log: this.log,
      api: () => this.api,
      inboundDenialReason: (userId, chatId) => this.inboundDenialReason(userId, chatId),
    });
    // Poll loop (card 7A-3). Live api accessor — NOT captured — so tests that
    // Object.assign a mock onto `bot.api` after construction are observed.
    this.poller = new Poller({
      api: () => this.api,
      pollIntervalMs: opts.pollIntervalSec * 1000,
      log: this.log,
      controller: new AbortController(),
      offsetStore: opts.offsetStore,
      lock: opts.lock,
      standbyRetryMs: opts.standbyRetryMs ?? 15_000,
      onCallbackQuery: (cq) => {
        void this.approvals
          .dispatchCallback(cq)
          .catch((err) =>
            this.log.debug(
              `Callback dispatch failed: ${err instanceof Error ? err.message : String(err)}`,
            ),
          );
      },
      onMessageUpdate: (msg) => this.processMessage({ ...msg, text: msg.text! }),
    });
  }

  // ------------------------------------------------------------------
  // Lifecycle
  // ------------------------------------------------------------------

  /** Start polling for updates. Idempotent. */
  start(): void {
    this.poller.start();
  }

  /** Stop polling and cancel all in-flight requests. */
  stop(): void {
    this.poller.stop();
    // Reject any pending approval requests so the host doesn't hang.
    this.approvals.cancelAll('shutdown');
    this.lock?.release();
    this.log.info('Telegram bot stopped');
  }

  /** True when the bot is started but waiting for the poll lock. */
  get standby(): boolean {
    return this.poller.standby;
  }

  get startedAt(): number | null {
    return this.poller.startedAt;
  }

  get running(): boolean {
    return this.poller.active;
  }

  // ------------------------------------------------------------------
  // Buffer — incoming messages the agent can read
  // ------------------------------------------------------------------

  /** Return buffered messages, newest first. Optionally filter by chat. */
  getMessages(opts?: {
    chatId?: string | number | undefined;
    limit?: number | undefined;
  }): TelegramIncomingMessage[] {
    let msgs = [...this.buffer].reverse();
    if (opts?.chatId) {
      const cid = String(opts.chatId);
      msgs = msgs.filter((m) => String(m.chatId) === cid);
    }
    const limit = opts?.limit ?? 20;
    return msgs.slice(0, limit);
  }

  /** Drop messages older than or equal to the given message ID from the buffer (optionally scoped to a specific chat). */
  acknowledge(lastMessageId: number, chatId?: string | number | undefined): number {
    const before = this.buffer.length;
    const cid =
      chatId !== undefined && chatId !== null && String(chatId).trim() !== ''
        ? String(chatId).trim()
        : undefined;
    const remaining: TelegramIncomingMessage[] = [];
    for (const buffered of this.buffer) {
      if (cid !== undefined) {
        if (String(buffered.chatId) === cid && buffered.messageId <= lastMessageId) {
          continue;
        }
      } else if (buffered.messageId <= lastMessageId) {
        continue;
      }
      remaining.push(buffered);
    }
    this.buffer.length = 0;
    this.buffer.push(...remaining);
    return before - this.buffer.length;
  }

  get bufferCount(): number {
    return this.buffer.length;
  }

  // ------------------------------------------------------------------
  // Outgoing — send a message
  // ------------------------------------------------------------------

  async sendMessage(
    chatId: string | number,
    text: string,
    signal?: AbortSignal | undefined,
  ): Promise<TelegramBotResponse<TelegramApiMessage>> {
    this.log.debug(`Sending Telegram message to ${chatId} (${text.length} chars)`);

    let lastErr: unknown;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const timeout = AbortSignal.timeout(10_000);
        const result = await this.api.sendMessage(chatId, text, {
          signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
          parseMode: this.getParseMode?.(),
        });
        return { ok: true, result };
      } catch (err) {
        lastErr = err;
        const decision = classifyRetry(err, attempt);
        if (!decision.retry) {
          if (attempt > 1)
            this.log.debug(
              `Telegram sendMessage terminal error on attempt ${attempt}, not retrying`,
            );
          break;
        }
        this.log.debug(
          `Telegram sendMessage attempt ${attempt} failed, retrying in ${decision.delayMs}ms...`,
        );
        await abortableSleep(decision.delayMs, signal);
      }
    }
    throw lastErr;
  }

  // ------------------------------------------------------------------
  // Outgoing — send a message with an inline keyboard
  // ------------------------------------------------------------------

  /**
   * Send a message that has up to one row of inline buttons (Telegram's
   * `inline_keyboard`). Used by `telegram_approve` to present a
   * yes/no prompt. The keyboard payload is opaque to the bot — callers
   * pass already-encoded `callback_data` strings (≤ 64 bytes each).
   */
  async sendMessageWithKeyboard(
    chatId: string | number,
    text: string,
    buttons: Array<{ text: string; callback_data: string }>,
    signal?: AbortSignal | undefined,
  ): Promise<TelegramBotResponse<TelegramApiMessage>> {
    let lastErr: unknown;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const timeout = AbortSignal.timeout(10_000);
        const result = await this.api.sendMessageWithKeyboard(chatId, text, buttons, {
          signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
          parseMode: this.getParseMode?.(),
        });
        return { ok: true, result };
      } catch (err) {
        lastErr = err;
        const decision = classifyRetry(err, attempt);
        if (!decision.retry) {
          if (attempt > 1)
            this.log.debug(
              `Telegram sendMessageWithKeyboard terminal error on attempt ${attempt}, not retrying`,
            );
          break;
        }
        await abortableSleep(decision.delayMs, signal);
      }
    }
    throw lastErr;
  }

  // ------------------------------------------------------------------
  // Health
  // ------------------------------------------------------------------

  async health(signal?: AbortSignal | undefined): Promise<{
    ok: boolean;
    username?: string | undefined;
    error?: string | undefined;
  }> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    try {
      const timeout = AbortSignal.timeout(5_000);
      const deadline = AbortSignal.any([ctrl.signal, timeout]);
      const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
      const user = await this.api.getMe({ signal: combined });
      return { ok: true, username: user.username };
    } catch (err) {
      if (err instanceof TelegramBotApiError) return { ok: false, error: err.description };
      if (err instanceof TelegramNetworkError) return { ok: false, error: err.detail };
      return { ok: false, error: (err as Error).message };
    } finally {
      clearTimeout(timer);
    }
  }

  // ------------------------------------------------------------------
  // Polling — moved to ./poller.ts in card 7A-3 (standby/lock retry, 409
  // conflict backoff, and the P1.6 cursor live there verbatim).
  // ------------------------------------------------------------------

  /**
   * Apply the inbound identity policy to every update type. A non-empty set is
   * a mandatory constraint: missing identity fails closed instead of bypassing
   * the allowlist. An empty set leaves that identity dimension unrestricted.
   */
  private inboundDenialReason(
    userId: string | undefined,
    chatId: string | undefined,
  ): 'user' | 'chat' | undefined {
    // Check the chat first so a doubly-blocked message cannot trigger an
    // unauthorized-user reply into an arbitrary, non-allowlisted chat.
    if (this.allowedChats.size > 0 && (chatId === undefined || !this.allowedChats.has(chatId))) {
      return 'chat';
    }
    if (this.allowedUsers.size > 0 && (userId === undefined || !this.allowedUsers.has(userId))) {
      return 'user';
    }
    return undefined;
  }

  private processMessage(msg: TelegramApiMessage & { text: string }): void {
    const chatId = String(msg.chat.id);
    const userId = msg.from ? String(msg.from.id) : undefined;
    const denialReason = this.inboundDenialReason(userId, chatId);

    if (denialReason === 'user') {
      this.log.debug(`Ignoring message from user ${userId ?? 'unknown'} (not in allowedUsers)`);
      // Best-effort denial notice: the reply itself can fail (bot blocked, chat
      // not found → non-retryable throw). Swallow so an unauthorized user
      // cannot spam a stream of unhandled rejections into the poll loop.
      void this.sendMessage(chatId, '⛔ You are not authorized to interact with this bot.').catch(
        (err) =>
          this.log.debug(
            `Failed to send denial notice: ${err instanceof Error ? err.message : String(err)}`,
          ),
      );
      return;
    }
    if (denialReason === 'chat') {
      this.log.debug(`Ignoring message from chat ${chatId} (not in allowedChats)`);
      return;
    }

    const incoming: TelegramIncomingMessage = {
      messageId: msg.message_id,
      chatId: msg.chat.id,
      chatType: msg.chat.type,
      userId: msg.from?.id,
      userName: msg.from?.username ?? msg.from?.first_name,
      text: msg.text,
      timestamp: msg.date * 1000,
    };

    // Push to circular buffer
    this.buffer.push(incoming);
    while (this.buffer.length > this.bufferMax) this.buffer.shift();

    this.onMessage(incoming);
  }

  // ------------------------------------------------------------------
  // Approval flow delegates (card 7A-2)
  //
  // The state machine lives in ./approval-flow.ts. The public surface
  // (awaitApproval / bindApprovalPrompt / cancelApproval) is unchanged for
  // tool callers; the white-box regression suite reaches the real owner
  // through `bot.approvals` (public readonly) instead of type-asserting
  // past `private`.
  // ------------------------------------------------------------------

  /** Pending approval requests — registry owned by ApprovalFlow. */
  get callbackWaiters(): ApprovalFlow['callbackWaiters'] {
    return this.approvals.callbackWaiters;
  }

  awaitApproval(input: TelegramApprovalRequestInput): Promise<TelegramApprovalResult> {
    return this.approvals.awaitApproval(input);
  }

  bindApprovalPrompt(requestId: string, promptMessageId: number): boolean {
    return this.approvals.bindApprovalPrompt(requestId, promptMessageId);
  }

  cancelApproval(requestId: string, fromUser = 'cancelled'): boolean {
    return this.approvals.cancelApproval(requestId, fromUser);
  }
}

// ---------------------------------------------------------------------------
// Helpers (moved to ./text-format.ts in card #7A-1; re-exported here so
// existing `../../src/bot.js` importers keep resolving without edits)
// ---------------------------------------------------------------------------

export { escapeHtml, truncateForTelegram } from './text-format.js';
