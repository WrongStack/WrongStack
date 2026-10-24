import type { Logger } from '@wrongstack/contracts/types';
import {
  abortableSleep,
  classifyRetry,
  type TelegramApiClient,
  type TelegramApiMessage,
  TelegramBotApiError,
  TelegramNetworkError,
} from './api-client.js';
import type { TelegramBotResponse } from './bot-types.js';
import { escapeHtml, escapeMarkdownV2, sliceUtf16Safe } from './text-format.js';

/** Telegram rejects any message over 4096 chars — the Bot API hard limit. */
const TELEGRAM_WIRE_LIMIT = 4096;

/**
 * Clamp an HTML-escaped wire text to the hard limit. Escaping expands text
 * up to 5x ('&' -> '&amp;'), so a raw message within every upstream cap can
 * still exceed the limit on the wire. Cutting escaped text can leave a
 * partial trailing entity ('&am'), which the parser also rejects, so cut
 * back to before the unterminated entity when that happens.
 */
function fitHtmlWireText(escaped: string): string {
  if (escaped.length <= TELEGRAM_WIRE_LIMIT) return escaped;
  const cut = sliceUtf16Safe(escaped, TELEGRAM_WIRE_LIMIT);
  const lastAmp = cut.lastIndexOf('&');
  const lastSemi = cut.lastIndexOf(';');
  // In escaped text every '&' opens '&amp;'/'&lt;'/'&gt;'; a trailing '&'
  // with no later ';' is a partially-cut entity.
  return lastAmp > lastSemi ? cut.slice(0, lastAmp) : cut;
}

/**
 * Clamp MarkdownV2-escaped wire text to the hard limit. Escaping doubles every
 * reserved character, and a cut that ends on an escaping `\` would escape
 * nothing — so drop an unpaired trailing backslash.
 */
function fitMarkdownV2WireText(escaped: string): string {
  if (escaped.length <= TELEGRAM_WIRE_LIMIT) return escaped;
  const cut = sliceUtf16Safe(escaped, TELEGRAM_WIRE_LIMIT);
  const trailing = /\\*$/.exec(cut)?.[0].length ?? 0;
  return trailing % 2 === 1 ? cut.slice(0, -1) : cut;
}

/** The text as it must go on the wire for `mode`: escaped literal text. */
function toWireText(text: string, mode: '' | 'HTML' | 'MarkdownV2' | undefined): string {
  if (mode === 'HTML') return fitHtmlWireText(escapeHtml(text));
  if (mode === 'MarkdownV2') return fitMarkdownV2WireText(escapeMarkdownV2(text));
  return text;
}

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
        const mode = this.deps.getParseMode?.();
        // Telegram's HTML parse mode requires literal < > & to be
        // entity-escaped; raw specials make the API reject the send (400).
        // Escaping expands text up to 5x, so clamp the wire text to the
        // hard limit (entity-safely) — raw caps alone don't bound it.
        const wireText = toWireText(text, mode);
        const timeout = AbortSignal.timeout(10_000);
        const result = await this.deps.api().sendMessage(chatId, wireText, {
          signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
          parseMode: mode,
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
        const mode = this.deps.getParseMode?.();
        // Same HTML-mode escaping + wire-limit contract as sendMessage above.
        const wireText = toWireText(text, mode);
        const timeout = AbortSignal.timeout(10_000);
        const result = await this.deps.api().sendMessageWithKeyboard(chatId, wireText, buttons, {
          signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
          parseMode: mode,
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
