import type { Logger } from '@wrongstack/core/types';
import type { OffsetStore } from './offset-store.js';
import type { PollLock } from './poll-lock.js';

/**
 * Bot-surface type contracts (card 7A-4).
 *
 * Type-only leaf extracted from bot.ts so the composer imports its public
 * shapes without dragging implementation modules into the type graph.
 */

export interface TelegramBotResponse<T> {
  ok: true;
  result: T;
}

/** Incoming message shape emitted as a custom event. */
export interface TelegramIncomingMessage {
  messageId: number;
  chatId: number;
  chatType: string;
  userId?: number | undefined;
  userName?: string | undefined;
  text: string;
  timestamp: number;
}

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
