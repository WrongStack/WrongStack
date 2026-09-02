import type { Tool } from '@wrongstack/core/types';
import type { TelegramBot } from '../bot.js';

interface TelegramReadInput {
  /** Filter to messages from a specific chat/user ID. Omit to see all chats. */
  chat_id?: string | number | undefined;
  /** Max messages to return (default: 10, max: 50). */
  limit?: number | undefined;
  /**
   * If a message_id is provided, acknowledge all messages up to and
   * including this ID (mark them as processed / remove from buffer).
   */
  ack_last?: number | undefined;
}

export function makeTelegramReadTool(opts: { bot: TelegramBot }): Tool<TelegramReadInput> {
  return {
    name: 'telegram_read',
    description:
      'Read recent incoming Telegram messages the bot has received, newest first. Returns messages with sender, text, and timestamp. After reading, acknowledge them with ack_last so they are cleared. When responding to a user via telegram_send, format your reply as natural prose — summarize findings, report outcomes clearly, do not paste raw data.',
    usageHint:
      'telegram_read(chat_id: "123456789", limit: 5, ack_last: 42) — read messages, then ack the highest message_id to clear them.',
    category: 'Telegram',
    inputSchema: {
      type: 'object',
      properties: {
        chat_id: {
          oneOf: [{ type: 'string' }, { type: 'integer' }],
          description: 'Read messages only from this chat/user.',
        },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 50,
          description: 'Max messages to return (default: 10).',
        },
        ack_last: {
          type: 'integer',
          description:
            'After processing messages, pass the highest message_id to clear them from the buffer.',
        },
      },
    },
    permission: 'auto',
    mutating: false,
    timeoutMs: 5_000,
    async execute(input) {
      const msgs = opts.bot.getMessages({
        chatId: input.chat_id,
        limit: input.limit ?? 10,
      });

      let acked = 0;
      if (input.ack_last !== undefined && input.ack_last > 0) {
        acked = opts.bot.acknowledge(input.ack_last, input.chat_id);
      }

      return {
        buffer_total: opts.bot.bufferCount,
        messages: msgs.map((m) => ({
          message_id: m.messageId,
          chat_id: m.chatId,
          chat_type: m.chatType,
          from: m.userName ?? `user_${m.userId ?? 'unknown'}`,
          text: m.text,
          ts: new Date(m.timestamp).toISOString(),
        })),
        acked,
        hint:
          acked > 0
            ? undefined
            : 'Use ack_last with the highest message_id to clear processed messages.',
      };
    },
  };
}
