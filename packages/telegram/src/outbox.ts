import type { Logger } from '@wrongstack/core/types';
import {
  abortableSleep,
  classifyRetry,
  type TelegramApiClient,
  type TelegramApiMessage,
  TelegramBotApiError,
  TelegramNetworkError,
} from './api-client.js';
import type { TelegramBotResponse } from './bot-types.js';

/**
 * Outbound Telegram API surface (card 7A-4): retry-wrapped senders and the
 * health probe. Moved verbatim from bot.ts (the P1.3 retry/backoff policy is
 * frozen behavior); only the state reads changed shape.
 */
export interface TelegramOutboxDeps {
  /**
   * Live api accessor — called at use time, NOT captured at construction
   * (card 7A-2 lesson): tests replace `bot.api` after construction via
   * Object.assign / property assignment, so a captured instance would never
   * see the mock.
   */
  api: () => TelegramApiClient;
  log: Logger;
  /** Resolved per attempt; empty string or `undefined` → plain text. */
  getParseMode?: (() => '' | 'HTML' | 'MarkdownV2' | undefined) | undefined;
}

export class TelegramOutbox {
  private readonly deps: TelegramOutboxDeps;

  constructor(deps: TelegramOutboxDeps) {
    this.deps = deps;
  }

  async sendMessage(
    chatId: string | number,
    text: string,
    signal?: AbortSignal | undefined,
  ): Promise<TelegramBotResponse<TelegramApiMessage>> {
    this.deps.log.debug(`Sending Telegram message to ${chatId} (${text.length} chars)`);

    let lastErr: unknown;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const timeout = AbortSignal.timeout(10_000);
        const result = await this.deps.api().sendMessage(chatId, text, {
          signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
          parseMode: this.deps.getParseMode?.(),
        });
        return { ok: true, result };
      } catch (err) {
        lastErr = err;
        const decision = classifyRetry(err, attempt);
        if (!decision.retry) {
          if (attempt > 1)
            this.deps.log.debug(
              `Telegram sendMessage terminal error on attempt ${attempt}, not retrying`,
            );
          break;
        }
        this.deps.log.debug(
          `Telegram sendMessage attempt ${attempt} failed, retrying in ${decision.delayMs}ms...`,
        );
        await abortableSleep(decision.delayMs, signal);
      }
    }
    throw lastErr;
  }

  /**
   * Send a message that has up to one row of inline buttons (Telegram's
   * `inline_keyboard`). Used by `telegram_approve` to present a
   * yes/no prompt. The keyboard payload is opaque to the outbox — callers
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
        const result = await this.deps.api().sendMessageWithKeyboard(chatId, text, buttons, {
          signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
          parseMode: this.deps.getParseMode?.(),
        });
        return { ok: true, result };
      } catch (err) {
        lastErr = err;
        const decision = classifyRetry(err, attempt);
        if (!decision.retry) {
          if (attempt > 1)
            this.deps.log.debug(
              `Telegram sendMessageWithKeyboard terminal error on attempt ${attempt}, not retrying`,
            );
          break;
        }
        await abortableSleep(decision.delayMs, signal);
      }
    }
    throw lastErr;
  }

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
      const user = await this.deps.api().getMe({ signal: combined });
      return { ok: true, username: user.username };
    } catch (err) {
      if (err instanceof TelegramBotApiError) return { ok: false, error: err.description };
      if (err instanceof TelegramNetworkError) return { ok: false, error: err.detail };
      return { ok: false, error: (err as Error).message };
    } finally {
      clearTimeout(timer);
    }
  }
}
