import { ToolCapabilities } from '@wrongstack/core/security';
import type { Logger, Tool } from '@wrongstack/core/types';
import type { TelegramBotOutbound } from '../bot-queue.js';
import type { TelegramBot } from '../bot.js';
import {
  resolveTelegramOutboundTarget,
  scrubTelegramOutboundText,
  type TelegramChatId,
} from '../security/outbound.js';
import { truncateForTelegram } from '../bot.js';

interface TelegramSendInput {
  /** Chat or user ID to send the message to. Falls back to config.notifyChatId when omitted. */
  chat_id?: string | number | undefined;
  /** Message text. */
  message: string;
}

export function makeTelegramSendTool(opts: {
  bot: TelegramBot;
  outbound?: TelegramBotOutbound | undefined;
  /** Paired/default target, resolved on every call for live config updates. */
  getDefaultChatId(): TelegramChatId | undefined;
  /** Additional trusted targets, resolved on every call for live config updates. */
  getAllowedOutboundChatIds?(): readonly TelegramChatId[];
  maxMessageLength: number;
  log: Logger;
}): Tool<TelegramSendInput> {
  return {
    name: 'telegram_send',
    description:
      'Send a scrubbed message to the paired Telegram chat or an explicitly allowed outbound chat. Write natural prose for a human reader; summarize results and never paste raw JSON, object dumps, credentials, or truncated tool output.',
    usageHint:
      'telegram_send(chat_id: "123456789", message: "Build completed — 12 tests passed, 0 failed. Deploying to staging now.")',
    category: 'Telegram',
    inputSchema: {
      type: 'object',
      properties: {
        chat_id: {
          oneOf: [{ type: 'string' }, { type: 'integer' }],
          description: 'Target chat or user ID. Uses the plugin default when omitted.',
        },
        message: {
          type: 'string',
          description:
            'Message text in natural, human-readable prose. Summarize results, include only key details. Do NOT paste raw JSON, object dumps, or unformatted tool output. Target 1–4 lines for readability on mobile.',
        },
      },
      required: ['message'],
    },
    permission: 'confirm',
    mutating: true,
    capabilities: [ToolCapabilities.NET_OUTBOUND],
    timeoutMs: 15_000,
    async execute(input, _ctx, toolOpts) {
      const chatId = resolveTelegramOutboundTarget(input.chat_id, opts);

      // Scrub before truncation so a credential is never split into fragments
      // that no longer match the shared detector.
      const scrubbed = scrubTelegramOutboundText(input.message);
      const truncated = truncateForTelegram(scrubbed, opts.maxMessageLength);

      opts.log.info(`telegram_send → chat_id=${chatId} (${truncated.length} chars)`);

      const res = opts.outbound
        ? await opts.outbound.sendManual(chatId, truncated)
        : toolOpts?.signal
          ? await opts.bot.sendMessage(chatId, truncated, toolOpts.signal)
          : await opts.bot.sendMessage(chatId, truncated);

      return {
        ok: res.ok,
        message_id: res.result?.message_id,
        chat: res.result?.chat
          ? {
              id: res.result.chat.id,
              type: res.result.chat.type,
              title: res.result.chat.title,
            }
          : undefined,
      };
    },
  };
}
