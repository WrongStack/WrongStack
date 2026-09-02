/**
 * TelegramNotificationChannel — NotificationChannel implementation for
 * one-way Telegram message delivery.
 *
 * This is the **notification-only** path: fire-and-forget messages sent to
 * a configured chat when the Notifier routes a `NotificationMessage` to
 * the `"telegram"` channel. It wraps `bot.sendMessage()` with the standard
 * scrubbing and truncation pipeline used by every outgoing Telegram message.
 *
 * This channel does NOT handle:
 *   - 2-way communication (telegram_read, telegram_approve, inline keyboards)
 *   - Manual sends via the telegram_send tool (those go through
 *     `TelegramBotOutbound.sendManual()` for queue ordering + error surfacing)
 *   - Slash commands or polling
 *
 * Those remain in the main `@wrongstack/telegram` plugin, which continues
 * to own the TelegramBot instance, the inbound poller, the outbound queue
 * for manual sends, and the system prompt contributor.
 *
 * @module telegram
 * @public
 */

import type { Logger } from '@wrongstack/core/types';
import type {
  NotificationChannel,
  NotificationLevel,
  NotificationMessage,
  NotificationResult,
} from '@wrongstack/core/notifications';
import type { TelegramBot } from './bot.js';
import { scrubTelegramOutboundText } from './security/outbound.js';
import { truncateForTelegram } from './bot.js';

// ---------------------------------------------------------------------------
// Level → emoji mapping for Telegram preview
// ---------------------------------------------------------------------------

const LEVEL_ICON: Record<NotificationLevel, string> = {
  info: 'ℹ️',
  warning: '⚠️',
  critical: '🚨',
};

// ---------------------------------------------------------------------------
// Channel
// ---------------------------------------------------------------------------

export interface TelegramNotificationChannelOptions {
  /** The TelegramBot instance (owned by the main plugin). */
  readonly bot: TelegramBot;
  /** Queue-backed notification sender used by the plugin runtime. */
  readonly enqueueNotification?: ((chatId: string | number, text: string) => void) | undefined;
  /** Target chat or user ID for all notifications sent through this channel. */
  readonly chatId: string | number;
  /**
   * Maximum message length in characters. Default 4000 (Telegram's hard
   * cap is 4096; `truncateForTelegram` clamps internally). Can be passed
   * as a live getter for dynamic config updates. */
  readonly maxMessageLength?: number | (() => number) | undefined;
  /** Logger for debug-level diagnostics. */
  readonly log?: Logger | undefined;
}

export class TelegramNotificationChannel implements NotificationChannel {
  readonly name = 'telegram' as const;
  readonly type = 'telegram' as const;

  readonly #bot: TelegramBot;
  readonly #chatId: string | number;
  readonly #enqueueNotification: ((chatId: string | number, text: string) => void) | undefined;
  readonly #getMaxLen: () => number;
  readonly #log: Logger | undefined;

  constructor(opts: TelegramNotificationChannelOptions) {
    this.#bot = opts.bot;
    this.#chatId = opts.chatId;
    this.#enqueueNotification = opts.enqueueNotification;
    const maxLenOption = opts.maxMessageLength;
    this.#getMaxLen =
      typeof maxLenOption === 'function' ? maxLenOption : () => maxLenOption ?? 4000;
    this.#log = opts.log;
  }

  /**
   * Deliver a notification message to the configured Telegram chat.
   *
   * Renders the `NotificationMessage` into a single Telegram text message:
   *   - Prepends a level-based emoji icon (ℹ️ / ⚠️ / 🚨)
   *   - Combines `title` (when present) and `body`
   *   - Runs through credential scrubbing
   *   - Truncates to the configured max length
   *
   * **Does not throw.** Transport errors are caught and returned as
   * `{ ok: false, error: "…" }`.
   */
  async deliver(msg: NotificationMessage): Promise<NotificationResult> {
    const deliveredAt = new Date().toISOString();
    try {
      // 1. Render the message for Telegram with level-based icon
      const icon = LEVEL_ICON[msg.level] ?? LEVEL_ICON.info;
      const parts: string[] = [];
      if (msg.title) parts.push(msg.title);
      parts.push(msg.body);
      const rawText = `${icon} ${parts.join('\n')}`;

      // 2. Scrub credentials — runs BEFORE truncation so a credential
      //    is never split across the boundary where the pattern can't match.
      const scrubbed = scrubTelegramOutboundText(rawText);

      // 3. Truncate to fit Telegram's message size limit
      const truncated = truncateForTelegram(scrubbed, this.#getMaxLen());

      // 4. Queue when the plugin runtime supplies its bounded outbound path.
      if (this.#enqueueNotification) {
        this.#enqueueNotification(this.#chatId, truncated);
        this.#log?.debug?.(`telegram notification queued (${truncated.length} chars)`);
        return { ok: true, channel: this.name, deliveredAt };
      }

      // Standalone channels retain direct delivery for backwards compatibility.
      const res = await this.#bot.sendMessage(this.#chatId, truncated);

      this.#log?.debug?.(
        `telegram notification delivered (${truncated.length} chars, ok=${res.ok})`,
      );

      return {
        ok: res.ok,
        channel: this.name,
        ...(res.ok ? {} : { error: `Telegram API returned ok=false` }),
        deliveredAt,
      };
    } catch (err) {
      this.#log?.debug?.(
        `telegram notification delivery failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return {
        ok: false,
        channel: this.name,
        error: err instanceof Error ? err.message : String(err),
        deliveredAt,
      };
    }
  }

  /**
   * Liveness probe — delegates to the bot's health check.
   * Returns `{ ok: true }` when the bot token is valid and
   * api.telegram.org is reachable.
   */
  async ping(): Promise<{ ok: boolean; error?: string | undefined }> {
    try {
      const h = await this.#bot.health();
      return { ok: h.ok, ...(h.ok ? {} : { error: h.error ?? 'health check failed' }) };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}
