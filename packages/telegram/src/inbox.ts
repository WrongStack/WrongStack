import type { Logger } from '@wrongstack/core/types';
import type { TelegramApiMessage } from './api-client.js';
import type { TelegramIncomingMessage } from './bot-types.js';

/**
 * Inbound message handling (card 7A-4): the bounded incoming-message buffer,
 * the allowlist identity policy, and update→incoming mapping. Moved verbatim
 * from bot.ts; the bot keeps thin delegates so its public surface and the
 * white-box suites (which reach this owner through `bot.inbox`) keep working.
 */
export interface TelegramInboxDeps {
  log: Logger;
  /** Max messages to buffer for the agent to read. */
  bufferMax: number;
  allowedUsers: Set<string>;
  allowedChats: Set<string>;
  /** Called for each incoming message that passes allowlist checks. */
  onMessage(msg: TelegramIncomingMessage): void;
  /**
   * Best-effort denial notice sender — wired to the bot's retry-wrapped
   * `sendMessage`. Failures are swallowed by `processMessage` so an
   * unauthorized user cannot spam unhandled rejections into the poll loop.
   */
  sendNotice(chatId: string | number, text: string): Promise<unknown>;
}

export class TelegramInbox {
  private readonly deps: TelegramInboxDeps;

  // Circular buffer for incoming messages. Public readonly so the white-box
  // suites can seed it directly through `bot.inbox.buffer` without
  // type-asserting past module boundaries.
  readonly buffer: TelegramIncomingMessage[] = [];

  constructor(deps: TelegramInboxDeps) {
    this.deps = deps;
  }

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

  /**
   * Apply the inbound identity policy to every update type. A non-empty set is
   * a mandatory constraint: missing identity fails closed instead of bypassing
   * the allowlist. An empty set leaves that identity dimension unrestricted.
   * Public because ApprovalFlow consumes the same gate via the bot's wiring.
   */
  denialReason(
    userId: string | undefined,
    chatId: string | undefined,
  ): 'user' | 'chat' | undefined {
    // Check the chat first so a doubly-blocked message cannot trigger an
    // unauthorized-user reply into an arbitrary, non-allowlisted chat.
    if (
      this.deps.allowedChats.size > 0 &&
      (chatId === undefined || !this.deps.allowedChats.has(chatId))
    ) {
      return 'chat';
    }
    if (
      this.deps.allowedUsers.size > 0 &&
      (userId === undefined || !this.deps.allowedUsers.has(userId))
    ) {
      return 'user';
    }
    return undefined;
  }

  processMessage(msg: TelegramApiMessage & { text: string }): void {
    const chatId = String(msg.chat.id);
    const userId = msg.from ? String(msg.from.id) : undefined;
    const denialReason = this.denialReason(userId, chatId);

    if (denialReason === 'user') {
      this.deps.log.debug(
        `Ignoring message from user ${userId ?? 'unknown'} (not in allowedUsers)`,
      );
      // Best-effort denial notice: the reply itself can fail (bot blocked, chat
      // not found → non-retryable throw). Swallow so an unauthorized user
      // cannot spam a stream of unhandled rejections into the poll loop.
      void this.deps
        .sendNotice(chatId, '⛔ You are not authorized to interact with this bot.')
        .catch((err) =>
          this.deps.log.debug(
            `Failed to send denial notice: ${err instanceof Error ? err.message : String(err)}`,
          ),
        );
      return;
    }
    if (denialReason === 'chat') {
      this.deps.log.debug(`Ignoring message from chat ${chatId} (not in allowedChats)`);
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
    while (this.buffer.length > this.deps.bufferMax) this.buffer.shift();

    this.deps.onMessage(incoming);
  }
}
